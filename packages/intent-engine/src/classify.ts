/**
 * Input classification — the zero-latency, zero-cost path.
 *
 * Anything that is already a destination never reaches a model: URLs, bare
 * domains, `localhost:3000`, IP addresses, and bang shortcuts all resolve here
 * in microseconds. Only genuine natural-language intent goes on to the pipeline.
 */

import type { Classification } from "./types.ts";

/**
 * Bang table. Kept deliberately small — these are the ones people actually type.
 * `%s` is replaced with the URL-encoded remainder of the query.
 */
export const BANGS: Record<string, string> = {
  w: "https://en.wikipedia.org/w/index.php?search=%s",
  wiki: "https://en.wikipedia.org/w/index.php?search=%s",
  gh: "https://github.com/search?q=%s",
  github: "https://github.com/search?q=%s",
  yt: "https://www.youtube.com/results?search_query=%s",
  youtube: "https://www.youtube.com/results?search_query=%s",
  so: "https://stackoverflow.com/search?q=%s",
  npm: "https://www.npmjs.com/search?q=%s",
  pypi: "https://pypi.org/search/?q=%s",
  crates: "https://crates.io/search?q=%s",
  mdn: "https://developer.mozilla.org/en-US/search?q=%s",
  hn: "https://hn.algolia.com/?q=%s",
  r: "https://www.reddit.com/search/?q=%s",
  reddit: "https://www.reddit.com/search/?q=%s",
  arxiv: "https://arxiv.org/abs/%s",
  scholar: "https://scholar.google.com/scholar?q=%s",
  maps: "https://www.openstreetmap.org/search?query=%s",
  imdb: "https://www.imdb.com/find?q=%s",
  amzn: "https://www.amazon.com/s?k=%s",
  g: "https://www.google.com/search?q=%s&udm=14",
  ddg: "https://duckduckgo.com/?q=%s",
  archive: "https://web.archive.org/web/*/%s",
};

/**
 * Natural language that means a bang. Lets "wikipedia for tardigrades" and
 * "!w tardigrades" take the identical code path — the user learns neither.
 */
const NATURAL_BANGS: { pattern: RegExp; bang: string }[] = [
  { pattern: /^(?:search\s+)?wikipedia\s+(?:for\s+|about\s+)?(.+)$/i, bang: "w" },
  { pattern: /^(.+?)\s+on\s+wikipedia$/i, bang: "w" },
  { pattern: /^(?:search\s+)?github\s+(?:for\s+)?(.+)$/i, bang: "gh" },
  { pattern: /^(.+?)\s+on\s+github$/i, bang: "gh" },
  { pattern: /^(?:search\s+)?youtube\s+(?:for\s+)?(.+)$/i, bang: "yt" },
  { pattern: /^(.+?)\s+on\s+youtube$/i, bang: "yt" },
  { pattern: /^(.+?)\s+on\s+reddit$/i, bang: "r" },
  { pattern: /^(?:search\s+)?npm\s+(?:for\s+)?(.+)$/i, bang: "npm" },
  { pattern: /^(.+?)\s+on\s+(?:stack\s?overflow)$/i, bang: "so" },
  { pattern: /^(?:search\s+)?(?:stack\s?overflow)\s+(?:for\s+)?(.+)$/i, bang: "so" },
  { pattern: /^(?:search\s+)?(?:hacker\s?news|hn)\s+(?:for\s+)?(.+)$/i, bang: "hn" },
];

/**
 * A hostname followed by an optional port/path/query — no scheme.
 * The TLD must be ≥2 alphabetic characters so "node.js" and "3.14" don't match.
 */
const BARE_DOMAIN =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?::\d{1,5})?(?:[/?#]\S*)?$/i;

/** `localhost`, `127.0.0.1:8080`, `192.168.1.5/admin` — the developer's daily path. */
const LOCAL_HOST = /^(?:localhost|(?:\d{1,3}\.){3}\d{1,3})(?::\d{1,5})?(?:[/?#]\S*)?$/i;

/** Schemes we are willing to hand to a WebView. */
const SAFE_SCHEMES = new Set(["http:", "https:", "about:", "file:", "view-source:"]);

export function classify(rawInput: string): Classification {
  const input = rawInput.trim();
  if (!input) return { kind: "search", query: "" };

  const bang = matchBang(input);
  if (bang) return bang;

  const explicit = matchExplicitUrl(input);
  if (explicit) return { kind: "url", url: explicit };

  // A bare domain must be a single token — "apple.com vs samsung.com" is a
  // comparison query, not a destination.
  if (!/\s/.test(input) && (BARE_DOMAIN.test(input) || LOCAL_HOST.test(input))) {
    return { kind: "url", url: `https://${input}` };
  }

  return { kind: "search", query: input };
}

function matchExplicitUrl(input: string): string | undefined {
  if (!/^[a-z][a-z0-9+.-]*:/i.test(input)) return undefined;
  try {
    const url = new URL(input);
    if (!SAFE_SCHEMES.has(url.protocol)) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function matchBang(input: string): Classification | undefined {
  // Explicit `!bang` — accepted in leading or trailing position.
  const leading = /^!([a-z0-9]+)(?:\s+(.*))?$/i.exec(input);
  const trailing = /^(.*?)\s+!([a-z0-9]+)$/i.exec(input);

  const key = (leading?.[1] ?? trailing?.[2] ?? "").toLowerCase();
  if (key && key in BANGS) {
    const rest = (leading ? (leading[2] ?? "") : (trailing?.[1] ?? "")).trim();
    return { kind: "bang", bang: key, url: expandBang(key, rest), rest };
  }

  // Natural-language equivalents.
  for (const { pattern, bang } of NATURAL_BANGS) {
    const match = pattern.exec(input);
    const rest = match?.[1]?.trim();
    if (rest) {
      return { kind: "bang", bang, url: expandBang(bang, rest), rest };
    }
  }

  return undefined;
}

export function expandBang(bang: string, rest: string): string {
  const template = BANGS[bang];
  if (!template) throw new Error(`unknown bang: !${bang}`);
  // An empty remainder means "just take me to the site", not "search for nothing".
  if (!rest) {
    const url = new URL(template.replace("%s", ""));
    return `${url.protocol}//${url.host}/`;
  }
  return template.replace("%s", encodeURIComponent(rest));
}

/**
 * Lowercased registrable-ish domain, `www.` stripped.
 *
 * Deliberately not a full public-suffix implementation: pulling in the PSL to
 * tell `co.uk` from `com` costs more than it buys us, since every consumer is
 * grouping and de-duplicating rather than making a security decision.
 */
export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Canonical form used for cache keys and duplicate detection.
 *
 * Drops the scheme, `www.`, tracking parameters, the fragment, and a trailing
 * slash — so the five URLs a query returns for the same page collapse into one.
 */
export function canonicaliseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");

    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(utm_|ref|fbclid|gclid|mc_|_hs|igshid|si$|s$)/i.test(key)) {
        parsed.searchParams.delete(key);
      }
    }
    parsed.searchParams.sort();

    let path = parsed.pathname.replace(/\/+$/, "");
    if (path === "") path = "/";

    const query = parsed.searchParams.toString();
    return `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}${path}${query ? `?${query}` : ""}`;
  } catch {
    return url;
  }
}

/** Normalised query text. Same words, same order → same cache key. */
export function normaliseQuery(query: string): string {
  return query
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
