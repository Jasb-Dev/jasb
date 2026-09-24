/**
 * Day-one tracker data.
 *
 * Before a user has visited anything, we still want the tracker penalty to bite.
 * This is a small curated table of per-domain third-party tracker counts drawn
 * from public datasets (DuckDuckGo Tracker Radar shape), plus a heuristic for
 * everything not in the table.
 *
 * It is intentionally tiny and legible rather than a 100 MB bundled dump: the
 * real signal comes from the browser measuring pages the user actually opens,
 * and this table only has to cover the first few sessions.
 */

export interface TrackerDataset {
  /** Third-party tracker count observed on the domain's typical page. */
  lookup(domain: string): number | undefined;
}

/**
 * Curated seed counts. Low numbers are sites known for clean pages; high
 * numbers are the heavy-monetisation end that Kagi's quality ranking pushes down.
 */
const SEED: Record<string, number> = {
  // Reference and docs — reliably clean
  "wikipedia.org": 0,
  "en.wikipedia.org": 0,
  "developer.mozilla.org": 1,
  "docs.python.org": 0,
  "man7.org": 0,
  "rust-lang.org": 1,
  "doc.rust-lang.org": 0,
  "go.dev": 1,
  "pkg.go.dev": 1,
  "nodejs.org": 2,
  "arxiv.org": 1,
  "nist.gov": 1,
  "ietf.org": 0,
  "rfc-editor.org": 0,
  "w3.org": 1,
  "postgresql.org": 1,
  "sqlite.org": 0,
  "kernel.org": 0,
  "gnu.org": 0,

  // Developer community
  "github.com": 3,
  "gitlab.com": 4,
  "stackoverflow.com": 6,
  "news.ycombinator.com": 0,
  "lobste.rs": 0,
  "sourcehut.org": 0,
  "codeberg.org": 0,

  // Big platforms — heavier
  "reddit.com": 9,
  "youtube.com": 11,
  "medium.com": 8,
  "quora.com": 17,
  "pinterest.com": 15,
  "x.com": 8,
  "facebook.com": 12,
  "linkedin.com": 13,

  // Commerce and content farms — the end of the curve the penalty targets
  "amazon.com": 14,
  "ebay.com": 16,
  "aliexpress.com": 21,
  "wikihow.com": 19,
  "ehow.com": 24,
  "answers.com": 26,
  "allrecipes.com": 27,
  "food.com": 25,
  "delish.com": 23,
  "taste.com.au": 22,

  // News — varies wildly
  "bbc.com": 5,
  "bbc.co.uk": 5,
  "reuters.com": 9,
  "apnews.com": 7,
  "npr.org": 6,
  "theguardian.com": 10,
  "nytimes.com": 12,
  "forbes.com": 31,
  "businessinsider.com": 28,
};

/** Domains whose whole business model is programmatic advertising. */
const HEAVY_TLD_HINTS = [
  /\.(?:blogspot|wordpress)\.com$/,
  /^(?:www\.)?[a-z0-9-]*(?:coupon|deals?|review[sz]?|top10|best-?\d)/,
];

/** Non-commercial TLDs that skew clean. */
const CLEAN_TLD_HINTS = [/\.(?:edu|gov|mil|int)$/, /\.ac\.[a-z]{2}$/, /\.gov\.[a-z]{2}$/];

export class SeedTrackerDataset implements TrackerDataset {
  #extra: Record<string, number>;

  constructor(extra: Record<string, number> = {}) {
    this.#extra = extra;
  }

  lookup(domain: string): number | undefined {
    const normalised = domain.toLowerCase().replace(/^www\./, "");

    const exact = this.#extra[normalised] ?? SEED[normalised];
    if (exact !== undefined) return exact;

    // Walk up the label chain: `docs.example.com` inherits `example.com`.
    const labels = normalised.split(".");
    for (let i = 1; i < labels.length - 1; i += 1) {
      const parent = labels.slice(i).join(".");
      const value = this.#extra[parent] ?? SEED[parent];
      if (value !== undefined) return value;
    }

    if (CLEAN_TLD_HINTS.some((pattern) => pattern.test(normalised))) return 1;
    if (HEAVY_TLD_HINTS.some((pattern) => pattern.test(normalised))) return 18;

    // Unknown. Return undefined rather than a guess — the scorer treats a
    // missing signal as neutral, which is honest, whereas a made-up average
    // would quietly rank every unknown domain identically.
    return undefined;
  }
}

/**
 * Merges locally measured counts over the seed table. Local evidence always
 * wins: it describes the page this user actually loaded, today.
 */
export function mergeTrackerSources(
  seed: TrackerDataset,
  measured: Record<string, number>,
): TrackerDataset {
  return {
    lookup(domain: string) {
      const normalised = domain.toLowerCase().replace(/^www\./, "");
      return measured[normalised] ?? seed.lookup(normalised);
    },
  };
}
