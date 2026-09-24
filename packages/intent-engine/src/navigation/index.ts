/**
 * The navigation index — our cheapest and fastest path.
 *
 * "figma sign in", "irs login", "npm docs" are single-destination requests.
 * Sending them to a paid search API and then to a model is pure waste: a
 * brand → official-URL map answers them in about ten microseconds for nothing.
 *
 * This ships as a small seed table plus the machinery to load a much larger
 * generated one (Tranco top ~1M + title/meta extraction). The resolver checks
 * it *before* the cache, because a hit here is cheaper than a cache read.
 */

import { normaliseQuery } from "../classify.ts";
import type { FetchLike } from "../types.ts";

export interface NavigationEntry {
  /** The canonical destination. */
  url: string;
  /** Alternate names people type. Matched after normalisation. */
  aliases?: string[];
  /**
   * Popularity-derived prior, 0..1. Combined with match quality to decide
   * whether we are confident enough to skip search entirely.
   */
  prior?: number;
}

export interface NavigationHit {
  url: string;
  brand: string;
  confidence: number;
}

/** Words that signal "take me to the site", not "tell me about the site". */
const NAVIGATIONAL_SUFFIXES = new Set([
  "login",
  "log in",
  "signin",
  "sign in",
  "sign up",
  "signup",
  "register",
  "dashboard",
  "account",
  "home",
  "homepage",
  "website",
  "site",
  "portal",
  "app",
  "docs",
  "documentation",
  "api",
  "pricing",
  "support",
  "help",
  "status",
  "careers",
  "jobs",
  "blog",
  "download",
  "downloads",
  "console",
]);

/** Paths that reliably exist for a given suffix, so we can land deeper than `/`. */
const SUFFIX_PATHS: Record<string, string> = {
  docs: "/docs",
  documentation: "/docs",
  api: "/docs",
  pricing: "/pricing",
  status: "/status",
  careers: "/careers",
  jobs: "/careers",
  blog: "/blog",
  support: "/support",
  help: "/help",
};

/**
 * Seed table. Deliberately small and hand-checked — enough to make the path
 * real and testable. The Phase 1 generator replaces it with ~1M entries.
 */
const SEED: Record<string, NavigationEntry> = {
  github: { url: "https://github.com", prior: 0.99 },
  figma: { url: "https://figma.com", prior: 0.95 },
  notion: { url: "https://notion.so", prior: 0.94 },
  linear: { url: "https://linear.app", prior: 0.9 },
  stripe: { url: "https://stripe.com", prior: 0.96 },
  vercel: { url: "https://vercel.com", prior: 0.92 },
  netlify: { url: "https://netlify.com", prior: 0.88 },
  cloudflare: { url: "https://cloudflare.com", prior: 0.95 },
  npm: { url: "https://npmjs.com", aliases: ["npmjs"], prior: 0.93 },
  pypi: { url: "https://pypi.org", prior: 0.9 },
  docker: { url: "https://docker.com", prior: 0.93 },
  kubernetes: { url: "https://kubernetes.io", aliases: ["k8s"], prior: 0.9 },
  postgres: { url: "https://postgresql.org", aliases: ["postgresql"], prior: 0.92 },
  redis: { url: "https://redis.io", prior: 0.9 },
  mdn: { url: "https://developer.mozilla.org", prior: 0.91 },
  anthropic: { url: "https://anthropic.com", prior: 0.9 },
  openai: { url: "https://openai.com", prior: 0.95 },
  huggingface: { url: "https://huggingface.co", aliases: ["hugging face"], prior: 0.9 },
  gmail: { url: "https://mail.google.com", prior: 0.98 },
  "google drive": { url: "https://drive.google.com", prior: 0.96 },
  youtube: { url: "https://youtube.com", prior: 0.99 },
  reddit: { url: "https://reddit.com", prior: 0.97 },
  wikipedia: { url: "https://wikipedia.org", prior: 0.98 },
  "hacker news": { url: "https://news.ycombinator.com", aliases: ["hn"], prior: 0.85 },
  irs: { url: "https://irs.gov", prior: 0.94 },
  usps: { url: "https://usps.com", prior: 0.93 },
  dmv: { url: "https://dmv.org", prior: 0.8 },
  nhs: { url: "https://nhs.uk", prior: 0.92 },
  linkedin: { url: "https://linkedin.com", prior: 0.97 },
  spotify: { url: "https://spotify.com", prior: 0.96 },
  netflix: { url: "https://netflix.com", prior: 0.97 },
  amazon: { url: "https://amazon.com", prior: 0.98 },
  aws: { url: "https://aws.amazon.com", prior: 0.95 },
  azure: { url: "https://azure.microsoft.com", prior: 0.93 },
  "google cloud": { url: "https://cloud.google.com", aliases: ["gcp"], prior: 0.92 },
  slack: { url: "https://slack.com", prior: 0.95 },
  discord: { url: "https://discord.com", prior: 0.95 },
  zoom: { url: "https://zoom.us", prior: 0.95 },
};

export interface NavigationIndexOptions {
  /** Additional or overriding entries, e.g. a generated Tranco-derived table. */
  entries?: Record<string, NavigationEntry>;
  /**
   * Confidence below which we return nothing and let the query go to search.
   * Default 0.75 — deliberately cautious: a wrong instant navigation is far
   * more annoying than a card grid the user has to click once.
   */
  minConfidence?: number;
}

export class NavigationIndex {
  #byName = new Map<string, { entry: NavigationEntry; brand: string }>();
  #minConfidence: number;

  constructor(options: NavigationIndexOptions = {}) {
    this.#minConfidence = options.minConfidence ?? 0.75;
    for (const [brand, entry] of Object.entries({ ...SEED, ...options.entries })) {
      const record = { entry, brand };
      this.#byName.set(normaliseQuery(brand), record);
      for (const alias of entry.aliases ?? []) {
        this.#byName.set(normaliseQuery(alias), record);
      }
    }
  }

  get size(): number {
    return this.#byName.size;
  }

  /**
   * Resolves a query to a destination, or `undefined` when unsure.
   *
   * Match tiers, most confident first:
   *   - the whole query is a brand      → "figma"
   *   - brand + navigational suffix     → "figma sign in"
   *   - suffix + brand                  → "login figma"
   *
   * Anything else — extra words, multiple brands, a question — is not
   * navigation and falls through to the full pipeline.
   */
  lookup(query: string): NavigationHit | undefined {
    const normalised = normaliseQuery(query);
    if (!normalised) return undefined;

    const exact = this.#byName.get(normalised);
    if (exact) {
      return this.#hit(exact, 0.98, "");
    }

    const words = normalised.split(" ");
    if (words.length < 2 || words.length > 4) return undefined;

    // Try every split point: the brand may be one word or several.
    for (let cut = 1; cut < words.length; cut += 1) {
      const head = words.slice(0, cut).join(" ");
      const tail = words.slice(cut).join(" ");

      const brandFirst = this.#byName.get(head);
      if (brandFirst && NAVIGATIONAL_SUFFIXES.has(tail)) {
        return this.#hit(brandFirst, 0.9, tail);
      }

      const brandLast = this.#byName.get(tail);
      if (brandLast && NAVIGATIONAL_SUFFIXES.has(head)) {
        return this.#hit(brandLast, 0.88, head);
      }
    }

    return undefined;
  }

  #hit(
    record: { entry: NavigationEntry; brand: string },
    baseConfidence: number,
    suffix: string,
  ): NavigationHit | undefined {
    const prior = record.entry.prior ?? 0.8;
    const confidence = baseConfidence * prior;
    if (confidence < this.#minConfidence) return undefined;

    const path = SUFFIX_PATHS[suffix];
    const url = path ? joinPath(record.entry.url, path) : record.entry.url;
    return { url, brand: record.brand, confidence };
  }
}

function joinPath(base: string, path: string): string {
  try {
    return new URL(path, base.endsWith("/") ? base : `${base}/`).toString();
  } catch {
    return base;
  }
}

/**
 * Confirms a guessed URL actually resolves before we send the user there.
 *
 * A `HEAD` that 405s is still a live host, so anything under 400 — plus 405 —
 * counts as alive. Network failure means "don't navigate", not "navigate and
 * show an error page".
 */
export async function verifyDestination(
  url: string,
  fetchLike: FetchLike,
  timeoutMs = 1_200,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchLike(url, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal,
    });
    return response.status < 400 || response.status === 405;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
