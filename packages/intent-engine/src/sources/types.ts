/**
 * Search source adapters.
 *
 * Bing's API shut down in 2025 and Google's Custom Search JSON API sunsets on
 * 2027-01-01. The search layer is therefore written provider-agnostic from day
 * one: adding a provider is one file, swapping the default is one config line.
 */

import type { Candidate, IntentType, Lens } from "../types.ts";

export interface SearchRequest {
  query: string;
  /** How many candidates this adapter should aim to return. */
  limit: number;
  intent: IntentType;
  lens: Lens;
  locale?: string;
  region?: string;
  signal?: AbortSignal;
}

export interface SearchSource {
  readonly name: string;
  /**
   * Which lenses this source is worth querying for. `"*"` means always.
   * Keeps Wikipedia out of shopping queries and Marginalia out of news.
   */
  readonly lenses: readonly Lens[] | "*";
  /** Cost in US dollars per 1000 queries. Drives the source budget. */
  readonly costPerThousand: number;
  search(request: SearchRequest): Promise<Candidate[]>;
}

export class SourceError extends Error {
  readonly source: string;
  readonly detail: unknown;

  constructor(message: string, source: string, detail?: unknown) {
    super(message);
    this.name = "SourceError";
    this.source = source;
    this.detail = detail;
  }
}

/** True when this source should be consulted for the given lens. */
export function sourceMatchesLens(source: SearchSource, lens: Lens): boolean {
  return source.lenses === "*" || source.lenses.includes(lens);
}
