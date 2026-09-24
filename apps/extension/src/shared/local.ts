/**
 * The user's own web.
 *
 * This is the extension's real advantage over the standalone browser: Chrome
 * already holds years of bookmarks and history, and a page you saved once is
 * usually a better answer than anything a fresh index can return. Those results
 * are merged in locally and never leave the machine — the server is not told
 * about them and could not be, because the query it receives is anonymous.
 */

import { canonicaliseUrl, domainOf, normaliseQuery, type Card } from "@jasb/intent-engine";

export interface LocalHit {
  url: string;
  title: string;
  domain: string;
  origin: "bookmark" | "history";
  /** Visit count for history; bookmarks get a flat weight. */
  weight: number;
}

/**
 * Searches bookmarks and history for the query.
 *
 * Chrome's own matching is generous, so we re-score locally: a bookmark counts
 * for more than a casual visit, and a title that contains every word of the
 * query counts for more than one that shares a single term.
 */
export async function searchLocal(query: string, limit = 4): Promise<LocalHit[]> {
  const normalised = normaliseQuery(query);
  if (normalised.length < 3) return [];

  const words = normalised.split(" ").filter((word) => word.length > 2);
  if (words.length === 0) return [];

  const [bookmarks, history] = await Promise.all([
    searchBookmarks(query),
    searchHistory(query),
  ]);

  const byUrl = new Map<string, LocalHit>();
  for (const hit of [...bookmarks, ...history]) {
    const key = canonicaliseUrl(hit.url) || hit.url;
    const existing = byUrl.get(key);
    // A bookmarked page that is also in history keeps the bookmark provenance —
    // that is the stronger statement of intent.
    if (!existing || (existing.origin === "history" && hit.origin === "bookmark")) {
      byUrl.set(key, hit);
    } else if (existing) {
      existing.weight = Math.max(existing.weight, hit.weight);
    }
  }

  return [...byUrl.values()]
    .map((hit) => ({ hit, score: localScore(hit, words) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ hit }) => hit);
}

function localScore(hit: LocalHit, words: string[]): number {
  const haystack = normaliseQuery(`${hit.title} ${hit.domain}`);
  const matched = words.filter((word) => haystack.includes(word)).length;
  if (matched === 0) return 0;

  const coverage = matched / words.length;
  const provenance = hit.origin === "bookmark" ? 1.4 : 1;
  // Visit count helps, but with a log so a site visited 500 times cannot bury
  // everything else.
  const familiarity = 1 + Math.log10(1 + hit.weight) / 2;
  return coverage * provenance * familiarity;
}

async function searchBookmarks(query: string): Promise<LocalHit[]> {
  if (!chrome.bookmarks?.search) return [];
  try {
    const nodes = await chrome.bookmarks.search({ query });
    return nodes.flatMap((node) => {
      if (!node.url || !node.url.startsWith("http")) return [];
      const domain = domainOf(node.url);
      if (!domain) return [];
      return [
        {
          url: node.url,
          title: node.title || domain,
          domain,
          origin: "bookmark" as const,
          weight: 5,
        },
      ];
    });
  } catch {
    // Permission revoked mid-session. Degrade to web results only.
    return [];
  }
}

async function searchHistory(query: string): Promise<LocalHit[]> {
  if (!chrome.history?.search) return [];
  try {
    const items = await chrome.history.search({
      text: query,
      maxResults: 30,
      // A year back: far enough to be useful, near enough to stay relevant.
      startTime: Date.now() - 365 * 24 * 60 * 60 * 1000,
    });
    return items.flatMap((item) => {
      if (!item.url || !item.url.startsWith("http")) return [];
      const domain = domainOf(item.url);
      if (!domain) return [];
      return [
        {
          url: item.url,
          title: item.title || domain,
          domain,
          origin: "history" as const,
          weight: item.visitCount ?? 1,
        },
      ];
    });
  } catch {
    return [];
  }
}

/**
 * Turns local hits into cards and merges them ahead of web results.
 *
 * A page the user already chose once outranks a stranger's page, so local hits
 * go first — but capped, because a new-tab grid that is only your own history
 * stops being a browser and becomes a bookmark manager.
 */
export function mergeLocalCards(local: LocalHit[], web: Card[], limit: number): Card[] {
  const localCards: Card[] = local.slice(0, 2).map((hit) => ({
    url: hit.url,
    title: hit.title,
    domain: hit.domain,
    reason: hit.origin === "bookmark" ? "Official site" : "In-depth guide",
    score: 1,
    confidence: 1,
    signals: {},
    faviconUrl: `https://${hit.domain}/favicon.ico`,
    origin: hit.origin,
  }));

  const seen = new Set(localCards.map((card) => canonicaliseUrl(card.url)));
  const rest = web.filter((card) => !seen.has(canonicaliseUrl(card.url)));

  return [...localCards, ...rest].slice(0, limit);
}
