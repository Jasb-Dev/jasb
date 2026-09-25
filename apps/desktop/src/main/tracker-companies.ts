/**
 * Who is behind a tracker host.
 *
 * "google-analytics.com and doubleclick.net were blocked" means little to
 * most people; "Google was trying to track you here" means a lot. This table
 * maps the most common tracking and advertising domains to the company that
 * operates them. It is our own short list of well-known facts, kept small on
 * purpose: the comprehensive databases (Ghostery's TrackerDB, DuckDuckGo's
 * Tracker Radar) are licensed for non-commercial use only, which a product
 * with paid plans cannot accept.
 *
 * Anything not listed is shown by its domain, which is still true, just less
 * friendly.
 */

const COMPANIES: Record<string, string> = {
  // Google
  "google-analytics.com": "Google",
  "googletagmanager.com": "Google",
  "googletagservices.com": "Google",
  "googlesyndication.com": "Google",
  "googleadservices.com": "Google",
  "doubleclick.net": "Google",
  "adservice.google.com": "Google",
  "googleoptimize.com": "Google",
  "2mdn.net": "Google",
  "app-measurement.com": "Google",
  // Meta
  "facebook.net": "Meta",
  "facebook.com": "Meta",
  "fbcdn.net": "Meta",
  // Microsoft
  "bing.com": "Microsoft",
  "clarity.ms": "Microsoft",
  "adnxs.com": "Microsoft (Xandr)",
  "licdn.com": "LinkedIn",
  "linkedin.com": "LinkedIn",
  // Amazon
  "amazon-adsystem.com": "Amazon",
  "assoc-amazon.com": "Amazon",
  // Measurement and analytics
  "scorecardresearch.com": "comScore",
  "comscore.com": "comScore",
  "quantserve.com": "Quantcast",
  "quantcount.com": "Quantcast",
  "chartbeat.com": "Chartbeat",
  "chartbeat.net": "Chartbeat",
  "hotjar.com": "Hotjar",
  "hotjar.io": "Hotjar",
  "segment.com": "Segment",
  "segment.io": "Segment",
  "mixpanel.com": "Mixpanel",
  "amplitude.com": "Amplitude",
  "newrelic.com": "New Relic",
  "nr-data.net": "New Relic",
  "optimizely.com": "Optimizely",
  "fullstory.com": "FullStory",
  "mouseflow.com": "Mouseflow",
  "crazyegg.com": "Crazy Egg",
  "parsely.com": "Parse.ly",
  "parse.ly": "Parse.ly",
  "omtrdc.net": "Adobe",
  "demdex.net": "Adobe",
  "adobedtm.com": "Adobe",
  "everesttech.net": "Adobe",
  "hubspot.com": "HubSpot",
  "hs-analytics.net": "HubSpot",
  "hs-scripts.com": "HubSpot",
  "mediamelon.com": "MediaMelon",
  "conviva.com": "Conviva",
  "yandex.ru": "Yandex",
  "mc.yandex.ru": "Yandex",
  // Advertising exchanges and networks
  "criteo.com": "Criteo",
  "criteo.net": "Criteo",
  "taboola.com": "Taboola",
  "outbrain.com": "Outbrain",
  "pubmatic.com": "PubMatic",
  "rubiconproject.com": "Magnite",
  "openx.net": "OpenX",
  "casalemedia.com": "Index Exchange",
  "adsrvr.org": "The Trade Desk",
  "moatads.com": "Oracle",
  "bluekai.com": "Oracle",
  "addthis.com": "Oracle",
  "rlcdn.com": "LiveRamp",
  "pippio.com": "LiveRamp",
  "lijit.com": "Sovrn",
  "sharethrough.com": "Sharethrough",
  "33across.com": "33Across",
  "teads.tv": "Teads",
  "smartadserver.com": "Equativ",
  "adform.net": "Adform",
  "media.net": "Media.net",
  "brightline.tv": "Brightline",
  "gammaplatform.com": "Gamma",
  "doubleverify.com": "DoubleVerify",
  "adsafeprotected.com": "Integral Ad Science",
  "tiktok.com": "TikTok",
  "analytics.tiktok.com": "TikTok",
  "ads-twitter.com": "X",
  "t.co": "X",
  "snapchat.com": "Snap",
  "sc-static.net": "Snap",
  "pinterest.com": "Pinterest",
  "pinimg.com": "Pinterest",
  "reddit.com": "Reddit",
  "redditstatic.com": "Reddit",
  // Sharing widgets and consent
  "addtoany.com": "AddToAny",
  "sharethis.com": "ShareThis",
  "onetrust.com": "OneTrust",
  "cookielaw.org": "OneTrust",
  "trustarc.com": "TrustArc",
};

/**
 * Names people recognise go first in "X and Y were trying to track you":
 * "Google and Meta" lands; "Brightline and Gamma" does not, even if the
 * latter fired more requests.
 */
const PROMINENCE = ["Google", "Meta", "Amazon", "Microsoft", "TikTok", "X", "LinkedIn", "Oracle", "Adobe", "Criteo", "comScore", "Taboola", "Outbrain"];

function prominence(name: string): number {
  const index = PROMINENCE.indexOf(name);
  return index === -1 ? PROMINENCE.length : index;
}

/** The company behind a host, or undefined when we do not know it. */
export function companyOf(host: string): string | undefined {
  const parts = host.toLowerCase().split(".");
  // Longest suffix first: "analytics.tiktok.com" before "tiktok.com".
  for (let i = 0; i < parts.length - 1; i += 1) {
    const suffix = parts.slice(i).join(".");
    const company = COMPANIES[suffix];
    if (company) return company;
  }
  return undefined;
}

/**
 * Groups hosts by company for display, most-blocked first. Unknown hosts are
 * their own group, labelled with the domain.
 */
export function groupByCompany(
  counts: Map<string, number>,
): { name: string; known: boolean; hosts: string[]; count: number }[] {
  const groups = new Map<string, { name: string; known: boolean; hosts: string[]; count: number }>();
  for (const [host, count] of counts) {
    const company = companyOf(host);
    const key = company ?? host;
    const group = groups.get(key) ?? { name: key, known: Boolean(company), hosts: [], count: 0 };
    group.hosts.push(host);
    group.count += count;
    groups.set(key, group);
  }
  return [...groups.values()].sort(
    (a, b) =>
      Number(b.known) - Number(a.known) ||
      prominence(a.name) - prominence(b.name) ||
      b.count - a.count,
  );
}
