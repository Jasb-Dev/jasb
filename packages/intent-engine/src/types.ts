/**
 * Core vocabulary of the engine.
 *
 * Everything the engine needs from the outside world is a port declared here.
 * The engine never touches `globalThis.fetch`, `localStorage`, a keychain, or a
 * clock directly — the host injects those. That is what lets one engine serve
 * the server, the web app, the Chrome extension and the Electron shell.
 */

// ---------------------------------------------------------------------------
// Intent
// ---------------------------------------------------------------------------

/** What the user is trying to do. Drives lens selection and cache TTL. */
export type IntentType =
  | "navigational"
  | "research"
  | "shopping"
  | "recipe"
  | "code"
  | "news"
  | "local"
  | "reference";

export const INTENT_TYPES: readonly IntentType[] = [
  "navigational",
  "research",
  "shopping",
  "recipe",
  "code",
  "news",
  "local",
  "reference",
];

/**
 * A lens is a source/domain bias. Kagi makes the user pick one; we infer it
 * from intent so the concept never surfaces in the UI.
 */
export type Lens =
  | "general"
  | "programming"
  | "forums"
  | "academic"
  | "docs"
  | "recipes"
  | "news"
  | "shopping"
  | "smallweb";

export const LENSES: readonly Lens[] = [
  "general",
  "programming",
  "forums",
  "academic",
  "docs",
  "recipes",
  "news",
  "shopping",
  "smallweb",
];

// ---------------------------------------------------------------------------
// Input classification
// ---------------------------------------------------------------------------

/** The engine short-circuits on anything that is already a destination. */
export type Classification =
  | { kind: "url"; url: string }
  | { kind: "bang"; bang: string; url: string; rest: string }
  | { kind: "search"; query: string };

// ---------------------------------------------------------------------------
// Candidates and cards
// ---------------------------------------------------------------------------

/** A raw result from one search source, before merge/dedupe/ranking. */
export interface Candidate {
  url: string;
  title: string;
  snippet: string;
  /** Registrable domain, lowercased, no `www.` */
  domain: string;
  /** Which adapters produced this URL. Multi-source agreement is a quality signal. */
  sources: string[];
  /** 0-based position in the source that ranked it best. */
  rank: number;
  /** `og:image` when the source supplies one. */
  imageUrl?: string;
  /** ISO 8601 publish date when the source supplies one. */
  publishedAt?: string;
  /** Source-supplied language tag, when known. */
  language?: string;
}

/** Per-candidate quality evidence. Every field is optional — absence is neutral. */
export interface QualitySignals {
  /** Third-party tracker count for the domain (open dataset or measured locally). */
  trackers?: number;
  /** Measured page load in ms, from a previous visit on this device. */
  loadMs?: number;
  /** True when a paywall or login wall was detected on a previous visit. */
  paywall?: boolean;
  /** Fraction of visits where the user bounced back within 3s. 0..1 */
  bounceRate?: number;
  /** Jev/Laya `noul` probability that this is content-farm / SEO spam. 0..1 */
  spamProbability?: number;
  /** Decider relevance score, normalised to 0..1 */
  relevance?: number;
  /** True when the domain is in a curated small-web index. */
  smallWeb?: boolean;
}

/** The unit the UI renders. Six of these is the whole product. */
export interface Card {
  url: string;
  title: string;
  domain: string;
  /**
   * Why this site — chosen from a fixed label set, never free text.
   * Keeps reasons short, consistent, translatable, and impossible to hallucinate.
   */
  reason: ReasonLabel;
  /** Final weighted quality score, 0..1. Used for ordering and for the badge row. */
  score: number;
  /** Decider confidence in the relevance judgement, 0..1. */
  confidence: number;
  signals: QualitySignals;
  /** `og:image` or favicon-derived preview. Real screenshots replace this after a visit. */
  thumbnailUrl?: string;
  faviconUrl?: string;
  /** Present when the user pinned this domain. */
  pinned?: boolean;
  /**
   * Where the card came from.
   *
   * The Chrome extension can surface the user's own bookmarks and history
   * alongside web results — years of accumulated signal available on day one —
   * and those need a visibly different provenance. Absent means the open web.
   */
  origin?: "web" | "bookmark" | "history";
}

// ---------------------------------------------------------------------------
// Requests and responses
// ---------------------------------------------------------------------------

export interface ResolveOptions {
  /** How many cards to return when confidence is high. Default 6. */
  maxCards?: number;
  /** Skip every cache layer and re-run the pipeline. */
  refresh?: boolean;
  /** BCP-47 tag used to bias sources, e.g. `en-US`. */
  locale?: string;
  /** Coarse location hint for `local` intent, e.g. `Berlin, DE`. */
  region?: string;
  /** Abort the whole pipeline. */
  signal?: AbortSignal;
}

export type ResolveResult =
  /** Input was a URL, a bang, or a high-confidence navigation hit — just go. */
  | {
      kind: "navigate";
      url: string;
      /** Why we skipped search. Surfaced in the UI as a one-word chip. */
      via: "url" | "bang" | "navigation-index" | "decider";
      confidence: number;
      tookMs: number;
    }
  /** The normal path: a grid of sites. */
  | {
      kind: "cards";
      query: string;
      intent: IntentType;
      lens: Lens;
      cards: Card[];
      /** True when served from a cache layer. */
      cached: boolean;
      /** Set when the decider was unsure and we deliberately returned fewer cards. */
      lowConfidence: boolean;
      tookMs: number;
      /** Per-stage timings, for the latency budget test in CI. */
      timings: Record<string, number>;
    };

// ---------------------------------------------------------------------------
// Reason labels — the fixed vocabulary that replaces generated prose
// ---------------------------------------------------------------------------

export const REASON_LABELS = [
  "Official site",
  "Official docs",
  "API reference",
  "Source repository",
  "Package page",
  "Forum discussion",
  "Q&A thread",
  "Issue tracker",
  "Encyclopedia entry",
  "Reference table",
  "In-depth guide",
  "Step-by-step tutorial",
  "Ad-free recipe",
  "Recipe collection",
  "Independent review",
  "Comparison roundup",
  "Price listing",
  "Retailer page",
  "News report",
  "Live updates",
  "Research paper",
  "Preprint archive",
  "Dataset",
  "Government resource",
  "Standards document",
  "Personal blog",
  "Small-web find",
  "Community wiki",
  "Video walkthrough",
  "Interactive tool",
  "Map or directions",
  "Local listing",
] as const;

export type ReasonLabel = (typeof REASON_LABELS)[number];

// ---------------------------------------------------------------------------
// Ports — the only way the engine reaches the outside world
// ---------------------------------------------------------------------------

/** Minimal `fetch`. Hosts pass `globalThis.fetch`, Electron's net, or a mock. */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
    redirect?: "follow" | "manual" | "error";
  },
) => Promise<{
  ok: boolean;
  status: number;
  url: string;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<unknown>;
}>;

export interface CacheEntry {
  query: string;
  /** Normalised-query hash; the shared cache key. */
  hash: string;
  intent: IntentType;
  lens: Lens;
  cards: Card[];
  storedAt: number;
  expiresAt: number;
  /** Optional embedding of the normalised query, for near-miss matching. */
  embedding?: number[];
}

export interface CacheStore {
  get(hash: string): Promise<CacheEntry | undefined>;
  /** Near-miss lookup. Implementations may return `undefined` if they have no embeddings. */
  nearest?(
    embedding: number[],
    minSimilarity: number,
  ): Promise<{ entry: CacheEntry; similarity: number } | undefined>;
  set(entry: CacheEntry): Promise<void>;
  delete(hash: string): Promise<void>;
  clear(): Promise<void>;
}

/** Local, per-device ranking preferences. Never leaves the machine. */
export interface PreferenceStore {
  blockedDomains(): Promise<string[]>;
  pinnedDomains(): Promise<string[]>;
  block(domain: string): Promise<void>;
  unblock(domain: string): Promise<void>;
  pin(domain: string): Promise<void>;
  unpin(domain: string): Promise<void>;
  /** Locally measured quality evidence, keyed by domain. */
  domainSignals?(domains: string[]): Promise<Record<string, QualitySignals>>;
}

/** Optional. Without it the cache degrades to exact-hash matching, which still works. */
export interface Embedder {
  embed(text: string): Promise<number[]>;
}

export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

export interface Clock {
  now(): number;
}
