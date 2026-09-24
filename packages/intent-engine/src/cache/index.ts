/**
 * The cache layer.
 *
 * Two lookups, cheapest first:
 *
 *   1. **Exact** — hash of the normalised query. Microseconds, no model call.
 *   2. **Near-miss** — cosine similarity over query embeddings, gated by a
 *      `noul` confirmation from the decider. Embedding similarity alone is too
 *      loose ("cheap flights to Lisbon" vs "cheap flights from Lisbon" are
 *      near-identical vectors and opposite intents), so the decider gets the
 *      final say before we serve someone else's cards.
 *
 * TTL is chosen by intent, not by a global constant: a news query goes stale in
 * an hour, a definition holds for a month.
 */

import { normaliseQuery } from "../classify.ts";
import type { Decider } from "../decider/types.ts";
import type { CacheEntry, CacheStore, Embedder, IntentType, Logger } from "../types.ts";

/** Cache lifetime per intent, in milliseconds. */
export const TTL_BY_INTENT: Record<IntentType, number> = {
  news: 60 * 60 * 1000, //        1 hour  — headlines move
  shopping: 6 * 60 * 60 * 1000, // 6 hours — prices move
  local: 24 * 60 * 60 * 1000, //   1 day   — hours and closures
  code: 7 * 24 * 60 * 60 * 1000, // 1 week  — versions move slowly
  research: 14 * 24 * 60 * 60 * 1000,
  recipe: 30 * 24 * 60 * 60 * 1000,
  reference: 30 * 24 * 60 * 60 * 1000,
  navigational: 30 * 24 * 60 * 60 * 1000,
};

export function ttlFor(intent: IntentType): number {
  return TTL_BY_INTENT[intent];
}

/**
 * FNV-1a, 64-bit, rendered as hex.
 *
 * Not a security primitive — this is a cache key, and the only property we need
 * is that the same normalised query always lands in the same bucket. Picked over
 * SHA-256 because it is synchronous: WebCrypto's digest is async, which would
 * make the fast path await for no benefit.
 */
export function hashQuery(query: string): string {
  const normalised = normaliseQuery(query);
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;

  for (let i = 0; i < normalised.length; i += 1) {
    hash = (hash ^ BigInt(normalised.charCodeAt(i))) & mask;
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const length = Math.min(a.length, b.length);
  if (length === 0) return 0;

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

export interface CacheLookupOptions {
  store: CacheStore;
  query: string;
  now: number;
  embedder?: Embedder;
  /** Confirms a near-miss really means the same thing. */
  decider?: Decider;
  /** Cosine threshold below which we don't even ask the decider. Default 0.86. */
  minSimilarity?: number;
  logger?: Logger;
  signal?: AbortSignal;
}

export interface CacheHit {
  entry: CacheEntry;
  /** `exact` skipped every model call; `semantic` paid one cheap `noul`. */
  via: "exact" | "semantic";
  similarity?: number;
}

export async function lookupCache(options: CacheLookupOptions): Promise<CacheHit | undefined> {
  const { store, query, now } = options;

  const hash = hashQuery(query);
  const exact = await store.get(hash);
  if (exact && exact.expiresAt > now) {
    return { entry: exact, via: "exact" };
  }
  if (exact) {
    // Expired: drop it so the store doesn't grow without bound.
    await store.delete(hash).catch(() => {});
  }

  if (!options.embedder || !store.nearest) return undefined;

  const minSimilarity = options.minSimilarity ?? 0.86;
  let embedding: number[];
  try {
    embedding = await options.embedder.embed(normaliseQuery(query));
  } catch (error) {
    options.logger?.warn("embedding failed; exact cache only", { error: String(error) });
    return undefined;
  }

  const near = await store.nearest(embedding, minSimilarity);
  if (!near || near.entry.expiresAt <= now) return undefined;

  // Vectors say "close". Only a decider can say "same intent".
  if (options.decider) {
    try {
      const answer = await options.decider.yesNo(
        { newQuery: query, cachedQuery: near.entry.query },
        {
          type: "noul",
          instructions:
            "Do these two search queries express the same user intent, such that " +
            "the exact same list of websites would satisfy both?",
        },
        options.signal,
      );
      if (answer.probability < 0.8) {
        options.logger?.debug("semantic cache rejected by decider", {
          query,
          cached: near.entry.query,
          probability: answer.probability,
        });
        return undefined;
      }
    } catch (error) {
      // Decider unavailable: be conservative and miss rather than serve
      // someone else's results for a query we never confirmed.
      options.logger?.warn("semantic cache confirmation failed; treating as miss", {
        error: String(error),
      });
      return undefined;
    }
  }

  return { entry: near.entry, via: "semantic", similarity: near.similarity };
}

// ---------------------------------------------------------------------------
// In-memory store — the default for tests, the extension, and the dev server
// ---------------------------------------------------------------------------

export interface MemoryCacheOptions {
  maxEntries?: number;
  now?: () => number;
}

export class MemoryCacheStore implements CacheStore {
  #entries = new Map<string, CacheEntry>();
  #maxEntries: number;
  #now: () => number;

  constructor(options: MemoryCacheOptions = {}) {
    this.#maxEntries = options.maxEntries ?? 500;
    this.#now = options.now ?? (() => Date.now());
  }

  async get(hash: string): Promise<CacheEntry | undefined> {
    const entry = this.#entries.get(hash);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.#now()) {
      this.#entries.delete(hash);
      return undefined;
    }
    // Refresh LRU position.
    this.#entries.delete(hash);
    this.#entries.set(hash, entry);
    return entry;
  }

  async nearest(
    embedding: number[],
    minSimilarity: number,
  ): Promise<{ entry: CacheEntry; similarity: number } | undefined> {
    const now = this.#now();
    let best: { entry: CacheEntry; similarity: number } | undefined;

    for (const entry of this.#entries.values()) {
      if (!entry.embedding || entry.expiresAt <= now) continue;
      const similarity = cosineSimilarity(embedding, entry.embedding);
      if (similarity >= minSimilarity && (!best || similarity > best.similarity)) {
        best = { entry, similarity };
      }
    }
    return best;
  }

  async set(entry: CacheEntry): Promise<void> {
    this.#entries.delete(entry.hash);
    this.#entries.set(entry.hash, entry);

    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      this.#entries.delete(oldest.value);
    }
  }

  async delete(hash: string): Promise<void> {
    this.#entries.delete(hash);
  }

  async clear(): Promise<void> {
    this.#entries.clear();
  }

  get size(): number {
    return this.#entries.size;
  }
}
