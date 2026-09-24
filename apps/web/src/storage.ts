/**
 * Local-first storage.
 *
 * History, favourites, block/pin rules and BYOK keys never leave the device.
 * On the web that means `localStorage`; the Electron shell swaps this module
 * for SQLite plus the OS keychain and nothing else changes.
 */

import type { PreferenceStore, QualitySignals } from "@jasb/intent-engine";

const KEYS = {
  device: "jasb.device",
  blocked: "jasb.blocked",
  pinned: "jasb.pinned",
  history: "jasb.history",
  favourites: "jasb.favourites",
  signals: "jasb.signals",
  byok: "jasb.byok",
  license: "jasb.license",
} as const;

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota exceeded or storage blocked. The session still works; only
    // persistence is lost, and nagging about it helps nobody.
  }
}

/**
 * The anonymous device token.
 *
 * Random, generated here, never derived from anything about the user or the
 * machine. It exists only so the server can count free searches without
 * knowing who is making them.
 */
export function deviceToken(): string {
  let token = read<string | null>(KEYS.device, null);
  if (!token) {
    token = crypto.randomUUID();
    write(KEYS.device, token);
  }
  return token;
}

// ---------------------------------------------------------------------------
// Ranking preferences
// ---------------------------------------------------------------------------

export function createPreferenceStore(): PreferenceStore & {
  snapshot(): { blocked: string[]; pinned: string[] };
} {
  return {
    blockedDomains: async () => read<string[]>(KEYS.blocked, []),
    pinnedDomains: async () => read<string[]>(KEYS.pinned, []),

    block: async (domain) => {
      write(KEYS.blocked, unique([...read<string[]>(KEYS.blocked, []), domain]));
      // Blocking implies un-pinning; holding both would be contradictory state.
      write(
        KEYS.pinned,
        read<string[]>(KEYS.pinned, []).filter((d) => d !== domain),
      );
    },
    unblock: async (domain) => {
      write(
        KEYS.blocked,
        read<string[]>(KEYS.blocked, []).filter((d) => d !== domain),
      );
    },
    pin: async (domain) => {
      write(KEYS.pinned, unique([...read<string[]>(KEYS.pinned, []), domain]));
      write(
        KEYS.blocked,
        read<string[]>(KEYS.blocked, []).filter((d) => d !== domain),
      );
    },
    unpin: async (domain) => {
      write(
        KEYS.pinned,
        read<string[]>(KEYS.pinned, []).filter((d) => d !== domain),
      );
    },

    domainSignals: async (domains) => {
      const all = read<Record<string, QualitySignals>>(KEYS.signals, {});
      const out: Record<string, QualitySignals> = {};
      for (const domain of domains) {
        const signals = all[domain];
        if (signals) out[domain] = signals;
      }
      return out;
    },

    snapshot: () => ({
      blocked: read<string[]>(KEYS.blocked, []),
      pinned: read<string[]>(KEYS.pinned, []),
    }),
  };
}

export function isBlocked(domain: string): boolean {
  return read<string[]>(KEYS.blocked, []).includes(domain);
}

export function isPinned(domain: string): boolean {
  return read<string[]>(KEYS.pinned, []).includes(domain);
}

// ---------------------------------------------------------------------------
// History and favourites
// ---------------------------------------------------------------------------

export interface HistoryEntry {
  query: string;
  at: number;
}

export function recordSearch(query: string): void {
  const history = read<HistoryEntry[]>(KEYS.history, []).filter(
    (entry) => entry.query !== query,
  );
  history.unshift({ query, at: Date.now() });
  write(KEYS.history, history.slice(0, 200));
}

export function recentSearches(limit = 8): HistoryEntry[] {
  return read<HistoryEntry[]>(KEYS.history, []).slice(0, limit);
}

export interface Favourite {
  url: string;
  title: string;
  domain: string;
  at: number;
}

export function toggleFavourite(entry: Omit<Favourite, "at">): boolean {
  const favourites = read<Favourite[]>(KEYS.favourites, []);
  const existing = favourites.findIndex((f) => f.url === entry.url);

  if (existing >= 0) {
    favourites.splice(existing, 1);
    write(KEYS.favourites, favourites);
    return false;
  }
  favourites.unshift({ ...entry, at: Date.now() });
  write(KEYS.favourites, favourites.slice(0, 500));
  return true;
}

export function favourites(): Favourite[] {
  return read<Favourite[]>(KEYS.favourites, []);
}

/** One button that empties everything this device has ever stored. */
export function clearEverything(): void {
  for (const key of Object.values(KEYS)) {
    // The device token is deliberately included: "clear everything" that
    // silently keeps a stable identifier would not be clearing everything.
    try {
      localStorage.removeItem(key);
    } catch {
      /* nothing to do */
    }
  }
}

// ---------------------------------------------------------------------------
// BYOK
// ---------------------------------------------------------------------------

export interface ByokSettings {
  systemOneUrl?: string;
  systemOneModel?: string;
  systemOneApiKey?: string;
  llmProvider?: "anthropic" | "openai" | "openrouter" | "gemini" | "ollama";
  llmApiKey?: string;
  llmModel?: string;
  llmBaseUrl?: string;
  braveApiKey?: string;
  searxngUrl?: string;
}

export function readByok(): ByokSettings {
  return read<ByokSettings>(KEYS.byok, {});
}

export function writeByok(settings: ByokSettings): void {
  write(KEYS.byok, settings);
}

export function hasByok(settings: ByokSettings = readByok()): boolean {
  return Boolean(
    settings.systemOneUrl || settings.llmApiKey || settings.braveApiKey || settings.searxngUrl,
  );
}

// ---------------------------------------------------------------------------
// Licence
// ---------------------------------------------------------------------------

/** A paid plan's key. Sent with each request so the server can apply the plan's quota. */
export function readLicense(): string {
  return read<string>(KEYS.license, "");
}

export function writeLicense(key: string): void {
  write(KEYS.license, key.trim().toLowerCase());
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
