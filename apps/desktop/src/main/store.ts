/**
 * Local storage: SQLite, on this machine, nowhere else.
 *
 * Holds the search cache, history, favourites, ranking rules and the quality
 * signals measured while browsing. Nothing here is ever uploaded; the shared
 * cache on the server is a separate, anonymous thing keyed only by query hash.
 */

import { join } from "node:path";

import Database from "better-sqlite3";
import { app } from "electron";

import type { CacheEntry, CacheStore, PreferenceStore, QualitySignals } from "@jasb/intent-engine";
import type { Favourite, HistoryEntry, Rules } from "../shared/ipc.ts";

export class LocalStore {
  #db: Database.Database;

  constructor(filename = join(app.getPath("userData"), "jasb.db")) {
    this.#db = new Database(filename);
    // WAL keeps reads fast while a write is in flight — the browser is writing
    // quality signals constantly while the user reads a page.
    this.#db.pragma("journal_mode = WAL");
    this.#db.pragma("synchronous = NORMAL");
    this.#migrate();
  }

  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS cache (
        hash        TEXT PRIMARY KEY,
        query       TEXT NOT NULL,
        intent      TEXT NOT NULL,
        lens        TEXT NOT NULL,
        cards       TEXT NOT NULL,
        embedding   BLOB,
        stored_at   INTEGER NOT NULL,
        expires_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS cache_expires ON cache(expires_at);

      CREATE TABLE IF NOT EXISTS history (
        query TEXT PRIMARY KEY,
        at    INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS history_at ON history(at DESC);

      CREATE TABLE IF NOT EXISTS favourites (
        url    TEXT PRIMARY KEY,
        title  TEXT NOT NULL,
        domain TEXT NOT NULL,
        at     INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS rules (
        domain TEXT PRIMARY KEY,
        kind   TEXT NOT NULL CHECK (kind IN ('blocked', 'pinned'))
      );

      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS domain_signals (
        domain       TEXT PRIMARY KEY,
        trackers     INTEGER,
        load_ms      INTEGER,
        paywall      INTEGER,
        visits       INTEGER NOT NULL DEFAULT 0,
        quick_backs  INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  // -------------------------------------------------------------------------
  // Cache
  // -------------------------------------------------------------------------

  cacheStore(now: () => number = () => Date.now()): CacheStore {
    const db = this.#db;

    return {
      async get(hash) {
        const row = db
          .prepare("SELECT * FROM cache WHERE hash = ? AND expires_at > ?")
          .get(hash, now()) as CacheRow | undefined;
        return row ? toCacheEntry(row) : undefined;
      },

      async nearest(embedding, minSimilarity) {
        // A brute-force scan over live entries. With a per-device cache that
        // tops out in the thousands this is microseconds — a vector index
        // would be more machinery than the problem deserves.
        const rows = db
          .prepare("SELECT * FROM cache WHERE expires_at > ? AND embedding IS NOT NULL")
          .all(now()) as CacheRow[];

        let best: { entry: CacheEntry; similarity: number } | undefined;
        for (const row of rows) {
          const stored = decodeEmbedding(row.embedding);
          if (!stored) continue;
          const similarity = cosine(embedding, stored);
          if (similarity >= minSimilarity && (!best || similarity > best.similarity)) {
            best = { entry: toCacheEntry(row), similarity };
          }
        }
        return best;
      },

      async set(entry) {
        db.prepare(
          `INSERT INTO cache (hash, query, intent, lens, cards, embedding, stored_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(hash) DO UPDATE SET
             cards = excluded.cards,
             embedding = excluded.embedding,
             stored_at = excluded.stored_at,
             expires_at = excluded.expires_at`,
        ).run(
          entry.hash,
          entry.query,
          entry.intent,
          entry.lens,
          JSON.stringify(entry.cards),
          entry.embedding ? encodeEmbedding(entry.embedding) : null,
          entry.storedAt,
          entry.expiresAt,
        );
      },

      async delete(hash) {
        db.prepare("DELETE FROM cache WHERE hash = ?").run(hash);
      },

      async clear() {
        db.prepare("DELETE FROM cache").run();
      },
    };
  }

  /** Drops expired rows. Called on startup so the file does not grow forever. */
  pruneCache(now = Date.now()): void {
    this.#db.prepare("DELETE FROM cache WHERE expires_at <= ?").run(now);
  }

  // -------------------------------------------------------------------------
  // Preferences
  // -------------------------------------------------------------------------

  preferenceStore(): PreferenceStore {
    const db = this.#db;

    const list = (kind: "blocked" | "pinned"): string[] =>
      (db.prepare("SELECT domain FROM rules WHERE kind = ?").all(kind) as { domain: string }[]).map(
        (row) => row.domain,
      );

    const set = (domain: string, kind: "blocked" | "pinned") => {
      // `ON CONFLICT` rather than delete-then-insert: blocking a pinned domain
      // flips it in one statement instead of leaving a window with neither.
      db.prepare(
        `INSERT INTO rules (domain, kind) VALUES (?, ?)
         ON CONFLICT(domain) DO UPDATE SET kind = excluded.kind`,
      ).run(domain, kind);
    };

    return {
      blockedDomains: async () => list("blocked"),
      pinnedDomains: async () => list("pinned"),
      block: async (domain) => set(domain, "blocked"),
      pin: async (domain) => set(domain, "pinned"),
      unblock: async (domain) => {
        db.prepare("DELETE FROM rules WHERE domain = ? AND kind = 'blocked'").run(domain);
      },
      unpin: async (domain) => {
        db.prepare("DELETE FROM rules WHERE domain = ? AND kind = 'pinned'").run(domain);
      },

      domainSignals: async (domains) => {
        if (domains.length === 0) return {};
        const placeholders = domains.map(() => "?").join(",");
        const rows = db
          .prepare(`SELECT * FROM domain_signals WHERE domain IN (${placeholders})`)
          .all(...domains) as SignalRow[];

        const out: Record<string, QualitySignals> = {};
        for (const row of rows) {
          const signals: QualitySignals = {};
          if (row.trackers !== null) signals.trackers = row.trackers;
          if (row.load_ms !== null) signals.loadMs = row.load_ms;
          if (row.paywall !== null) signals.paywall = row.paywall === 1;
          if (row.visits > 0) signals.bounceRate = row.quick_backs / row.visits;
          out[row.domain] = signals;
        }
        return out;
      },
    };
  }

  // -------------------------------------------------------------------------
  // Settings: small JSON values that belong to this device
  // -------------------------------------------------------------------------

  setting<T>(key: string, fallback: T): T {
    const row = this.#db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    if (!row) return fallback;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return fallback;
    }
  }

  setSetting(key: string, value: unknown): void {
    this.#db
      .prepare(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, JSON.stringify(value));
  }

  rules(): Rules {
    const rows = this.#db.prepare("SELECT domain, kind FROM rules").all() as {
      domain: string;
      kind: "blocked" | "pinned";
    }[];
    return {
      blocked: rows.filter((row) => row.kind === "blocked").map((row) => row.domain),
      pinned: rows.filter((row) => row.kind === "pinned").map((row) => row.domain),
    };
  }

  // -------------------------------------------------------------------------
  // Quality signals measured while browsing
  // -------------------------------------------------------------------------

  /**
   * Records what a real page load looked like.
   *
   * This is the moat the roadmap identifies: Kagi has to crawl to learn a page
   * is slow and ad-heavy, we find out for free the moment the user opens it.
   */
  recordVisit(domain: string, measurement: { trackers: number; loadMs: number; quickBack: boolean }): void {
    this.#db
      .prepare(
        `INSERT INTO domain_signals (domain, trackers, load_ms, visits, quick_backs)
         VALUES (?, ?, ?, 1, ?)
         ON CONFLICT(domain) DO UPDATE SET
           -- Exponential moving average: recent loads matter more than a
           -- measurement from six months and three redesigns ago.
           trackers = CAST(round(domain_signals.trackers * 0.7 + excluded.trackers * 0.3) AS INTEGER),
           load_ms  = CAST(round(domain_signals.load_ms  * 0.7 + excluded.load_ms  * 0.3) AS INTEGER),
           visits = domain_signals.visits + 1,
           quick_backs = domain_signals.quick_backs + excluded.quick_backs`,
      )
      .run(domain, measurement.trackers, Math.round(measurement.loadMs), measurement.quickBack ? 1 : 0);
  }

  markPaywall(domain: string, paywall: boolean): void {
    this.#db
      .prepare(
        `INSERT INTO domain_signals (domain, paywall) VALUES (?, ?)
         ON CONFLICT(domain) DO UPDATE SET paywall = excluded.paywall`,
      )
      .run(domain, paywall ? 1 : 0);
  }

  // -------------------------------------------------------------------------
  // History and favourites
  // -------------------------------------------------------------------------

  recordSearch(query: string): void {
    this.#db
      .prepare(
        `INSERT INTO history (query, at) VALUES (?, ?)
         ON CONFLICT(query) DO UPDATE SET at = excluded.at`,
      )
      .run(query, Date.now());
  }

  history(limit = 50): HistoryEntry[] {
    return this.#db
      .prepare("SELECT query, at FROM history ORDER BY at DESC LIMIT ?")
      .all(limit) as HistoryEntry[];
  }

  favourites(): Favourite[] {
    return this.#db
      .prepare("SELECT url, title, domain, at FROM favourites ORDER BY at DESC")
      .all() as Favourite[];
  }

  toggleFavourite(entry: Omit<Favourite, "at">): boolean {
    const existing = this.#db.prepare("SELECT url FROM favourites WHERE url = ?").get(entry.url);
    if (existing) {
      this.#db.prepare("DELETE FROM favourites WHERE url = ?").run(entry.url);
      return false;
    }
    this.#db
      .prepare("INSERT INTO favourites (url, title, domain, at) VALUES (?, ?, ?, ?)")
      .run(entry.url, entry.title, entry.domain, Date.now());
    return true;
  }

  /** The one-button erase the privacy label promises. */
  clearAll(): void {
    this.#db.exec(`
      DELETE FROM cache;
      DELETE FROM history;
      DELETE FROM favourites;
      DELETE FROM rules;
      DELETE FROM domain_signals;
      DELETE FROM settings;
      VACUUM;
    `);
  }

  close(): void {
    this.#db.close();
  }
}

// ---------------------------------------------------------------------------

interface CacheRow {
  hash: string;
  query: string;
  intent: string;
  lens: string;
  cards: string;
  embedding: Buffer | null;
  stored_at: number;
  expires_at: number;
}

interface SignalRow {
  domain: string;
  trackers: number | null;
  load_ms: number | null;
  paywall: number | null;
  visits: number;
  quick_backs: number;
}

function toCacheEntry(row: CacheRow): CacheEntry {
  const embedding = decodeEmbedding(row.embedding);
  return {
    hash: row.hash,
    query: row.query,
    intent: row.intent as CacheEntry["intent"],
    lens: row.lens as CacheEntry["lens"],
    cards: JSON.parse(row.cards) as CacheEntry["cards"],
    storedAt: row.stored_at,
    expiresAt: row.expires_at,
    ...(embedding ? { embedding } : {}),
  };
}

/** Float32 blob rather than JSON: a 768-dim vector is 3 KB instead of ~15 KB. */
function encodeEmbedding(values: number[]): Buffer {
  return Buffer.from(new Float32Array(values).buffer);
}

function decodeEmbedding(blob: Buffer | null): number[] | undefined {
  if (!blob || blob.length === 0) return undefined;
  const view = new Float32Array(blob.buffer, blob.byteOffset, blob.length / 4);
  return Array.from(view);
}

function cosine(a: readonly number[], b: readonly number[]): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
