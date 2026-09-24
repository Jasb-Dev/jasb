/**
 * Fan out to every relevant source, then merge into one candidate pool.
 *
 * Two rules matter here:
 *
 *   1. **A slow source must never hold up the grid.** Sources run in parallel
 *      with an overall deadline; whatever has arrived when the deadline passes
 *      is what we rank. One dead provider costs us its candidates, not the query.
 *   2. **Agreement is signal.** When several independent indexes surface the
 *      same URL, that is real evidence — we keep the merged candidate's best
 *      rank and record every source that found it.
 */

import { canonicaliseUrl } from "../classify.ts";
import type { Candidate, Logger } from "../types.ts";
import { sourceMatchesLens, type SearchRequest, type SearchSource } from "./types.ts";

export interface MergeOptions {
  sources: SearchSource[];
  request: SearchRequest;
  /** Hard ceiling for the whole fan-out. Default 2500 ms. */
  deadlineMs?: number;
  /**
   * Grace period granted to the remaining sources once the first one has
   * answered. Default 400 ms.
   *
   * Without this, one unreachable provider costs every query the full hard
   * deadline even though usable candidates arrived in 200 ms. The grace window
   * is what keeps the p50 near the fastest source rather than the slowest.
   */
  graceMs?: number;
  logger?: Logger;
}

export interface MergeResult {
  candidates: Candidate[];
  /** Sources that answered in time. */
  used: string[];
  /** Sources that errored or timed out, with the reason. */
  failed: { source: string; reason: string }[];
}

export async function mergeSources(options: MergeOptions): Promise<MergeResult> {
  const { request, logger } = options;
  const deadlineMs = options.deadlineMs ?? 2_500;

  const eligible = options.sources.filter((source) => sourceMatchesLens(source, request.lens));
  if (eligible.length === 0) {
    return { candidates: [], used: [], failed: [] };
  }

  const used: string[] = [];
  const failed: { source: string; reason: string }[] = [];

  // A shared abort so a source that is still in flight at the cut-off is
  // actually cancelled rather than left running and billed.
  const deadline = new AbortController();
  const hardTimer = setTimeout(() => deadline.abort(), deadlineMs);
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const forwardAbort = () => deadline.abort();
  request.signal?.addEventListener("abort", forwardAbort, { once: true });

  const graceMs = options.graceMs ?? 400;
  const startGrace = () => {
    graceTimer ??= setTimeout(() => deadline.abort(), graceMs);
  };

  let settled: PromiseSettledResult<{ source: string; candidates: Candidate[] }>[];
  try {
    settled = await Promise.allSettled(
      eligible.map(async (source) => {
        const candidates = await source.search({ ...request, signal: deadline.signal });
        // Only a source that actually produced something starts the clock —
        // an instant empty result should not cut off the one real index.
        if (candidates.length > 0) startGrace();
        return { source: source.name, candidates };
      }),
    );
  } finally {
    clearTimeout(hardTimer);
    if (graceTimer) clearTimeout(graceTimer);
    request.signal?.removeEventListener("abort", forwardAbort);
  }

  const pool: Candidate[] = [];
  for (const [index, outcome] of settled.entries()) {
    const sourceName = eligible[index]?.name ?? "unknown";
    if (outcome.status === "fulfilled") {
      used.push(sourceName);
      pool.push(...outcome.value.candidates);
    } else {
      const reason = String(outcome.reason);
      failed.push({ source: sourceName, reason });
      logger?.warn("search source failed", { source: sourceName, reason });
    }
  }

  return { candidates: dedupe(pool), used, failed };
}

/**
 * Collapses duplicates by canonical URL, then by (domain + normalised title) so
 * `example.com/post` and `example.com/post?amp=1` count once.
 */
export function dedupe(candidates: Candidate[]): Candidate[] {
  const byKey = new Map<string, Candidate>();

  for (const candidate of candidates) {
    const key = canonicaliseUrl(candidate.url) || candidate.url;
    const existing = byKey.get(key);

    if (!existing) {
      byKey.set(key, { ...candidate, sources: [...candidate.sources] });
      continue;
    }

    // Merge: keep the best rank, union the sources, fill in missing metadata.
    existing.rank = Math.min(existing.rank, candidate.rank);
    for (const source of candidate.sources) {
      if (!existing.sources.includes(source)) existing.sources.push(source);
    }
    if (!existing.imageUrl && candidate.imageUrl) existing.imageUrl = candidate.imageUrl;
    if (!existing.publishedAt && candidate.publishedAt) {
      existing.publishedAt = candidate.publishedAt;
    }
    if (candidate.snippet.length > existing.snippet.length) {
      existing.snippet = candidate.snippet;
    }
  }

  const titleSeen = new Set<string>();
  const out: Candidate[] = [];
  for (const candidate of byKey.values()) {
    const titleKey = `${candidate.domain}::${candidate.title.toLowerCase().replace(/\W+/g, " ").trim()}`;
    if (titleSeen.has(titleKey)) continue;
    titleSeen.add(titleKey);
    out.push(candidate);
  }

  // Stable order: multi-source agreement first, then best rank.
  return out.sort(
    (a, b) => b.sources.length - a.sources.length || a.rank - b.rank,
  );
}
