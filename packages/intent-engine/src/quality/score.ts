/**
 * Quality scoring — the Kagi layer, made invisible.
 *
 * Kagi produces its quality signal by crawling. A browser gets it for free: the
 * moment the user opens a page we can count third-party requests, time the
 * load, and notice a bounce inside three seconds. That evidence lives on the
 * device and feeds the *personal* ranking first; only aggregated, k-anonymous,
 * domain-level data would ever be shared, and only opt-in.
 *
 * Until a domain has been visited, we fall back to an open tracker dataset so
 * day-one ranking is still better than raw provider order.
 */

import type { Candidate, QualitySignals } from "../types.ts";

/** Weights sum to 1 across the signals that are present; absent signals renormalise. */
export interface ScoreWeights {
  relevance: number;
  sourceAgreement: number;
  sourceRank: number;
  trackers: number;
  spam: number;
  speed: number;
  bounce: number;
  paywall: number;
  smallWeb: number;
}

export const DEFAULT_WEIGHTS: ScoreWeights = {
  relevance: 0.4,
  sourceAgreement: 0.08,
  sourceRank: 0.12,
  trackers: 0.12,
  spam: 0.12,
  speed: 0.06,
  bounce: 0.06,
  paywall: 0.02,
  smallWeb: 0.02,
};

export interface ScoreInput {
  candidate: Candidate;
  signals: QualitySignals;
  /** How many sources were consulted — needed to normalise agreement. */
  sourceCount: number;
  weights?: ScoreWeights;
}

/**
 * Combines every available signal into 0..1.
 *
 * Each contributor returns `undefined` when it has nothing to say, and the
 * weighted mean is taken over what remains. That way a freshly-installed
 * browser with no local history ranks on relevance and trackers alone, and
 * gets strictly better as evidence accumulates — no cold-start cliff.
 */
export function qualityScore(input: ScoreInput): number {
  const weights = input.weights ?? DEFAULT_WEIGHTS;
  const { candidate, signals } = input;

  const parts: { weight: number; value: number }[] = [];
  const add = (weight: number, value: number | undefined) => {
    if (value !== undefined && Number.isFinite(value)) {
      parts.push({ weight, value: clamp01(value) });
    }
  };

  add(weights.relevance, signals.relevance);

  // Agreement across independent indexes, normalised by how many we asked.
  if (input.sourceCount > 1) {
    add(
      weights.sourceAgreement,
      (candidate.sources.length - 1) / (input.sourceCount - 1),
    );
  }

  // Provider rank, decayed. Position 0 → 1.0, position 19 → ~0.2.
  add(weights.sourceRank, 1 / (1 + candidate.rank * 0.25));

  add(weights.trackers, trackerScore(signals.trackers));
  add(weights.spam, signals.spamProbability === undefined ? undefined : 1 - signals.spamProbability);
  add(weights.speed, speedScore(signals.loadMs));
  add(weights.bounce, signals.bounceRate === undefined ? undefined : 1 - signals.bounceRate);
  add(weights.paywall, signals.paywall === undefined ? undefined : signals.paywall ? 0 : 1);
  add(weights.smallWeb, signals.smallWeb ? 1 : undefined);

  const totalWeight = parts.reduce((sum, part) => sum + part.weight, 0);
  if (totalWeight === 0) return 0.5;

  return clamp01(parts.reduce((sum, part) => sum + part.weight * part.value, 0) / totalWeight);
}

/**
 * Tracker penalty. Zero trackers is a perfect 1.0; the curve is steep early
 * (0 → 3 trackers costs more than 20 → 30) because the difference between a
 * clean page and a lightly-instrumented one is what readers actually feel.
 */
export function trackerScore(trackers: number | undefined): number | undefined {
  if (trackers === undefined) return undefined;
  if (trackers <= 0) return 1;
  return clamp01(1 / (1 + trackers / 4));
}

/** Load time. Under 500 ms is perfect; 5 s or worse is 0. */
export function speedScore(loadMs: number | undefined): number | undefined {
  if (loadMs === undefined) return undefined;
  if (loadMs <= 500) return 1;
  if (loadMs >= 5_000) return 0;
  return clamp01(1 - (loadMs - 500) / 4_500);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Applies the user's own rules last, after every automatic signal.
 *
 * This is the local-personalisation step the privacy design depends on: the
 * server returns an anonymous candidate list, and block/pin is applied here,
 * on the device, just before the cards are laid out.
 *
 * "Pin" means *always first*, not "score bonus". A bonus large enough to beat a
 * strong result would also distort every comparison below it, and a bonus small
 * enough not to would silently fail to pin — so pinning is expressed in the sort
 * order and the `score` field stays an honest quality measurement.
 */
export function applyPreferences<T extends { domain: string; score: number }>(
  items: T[],
  preferences: { blocked: Set<string>; pinned: Set<string> },
): (T & { pinned?: boolean })[] {
  const kept = items
    .filter((item) => !matchesDomain(item.domain, preferences.blocked))
    .map((item) => {
      // Drop any `pinned` flag that rode along from a shared cache — pinning is
      // this device's opinion, not the sender's.
      const { pinned: _stale, ...rest } = item as T & { pinned?: boolean };
      const base = rest as T;
      return matchesDomain(item.domain, preferences.pinned)
        ? { ...base, pinned: true }
        : base;
    });

  return kept.sort((a, b) => {
    const aPinned = "pinned" in a && a.pinned ? 1 : 0;
    const bPinned = "pinned" in b && b.pinned ? 1 : 0;
    return bPinned - aPinned || b.score - a.score;
  });
}

/** `blog.example.com` matches a rule for `example.com`, but not the reverse. */
function matchesDomain(domain: string, rules: Set<string>): boolean {
  if (rules.has(domain)) return true;
  for (const rule of rules) {
    if (domain.endsWith(`.${rule}`)) return true;
  }
  return false;
}
