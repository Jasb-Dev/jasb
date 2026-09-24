/**
 * Serper — real Google results, $0.30–1 per 1000 queries.
 *
 * The cheapest option by a wide margin, and deliberately *not* the default.
 * Google sued SerpApi in December 2025 over scraped results; that litigation
 * casts a shadow over every provider in this class, so we keep an independent
 * index in front and leave Serper as an explicit opt-in.
 */

import { domainOf } from "../classify.ts";
import type { Candidate, FetchLike } from "../types.ts";
import { SourceError, type SearchRequest, type SearchSource } from "./types.ts";

export interface SerperConfig {
  apiKey: string;
  fetch: FetchLike;
  baseUrl?: string;
  timeoutMs?: number;
}

interface SerperOrganic {
  link?: string;
  title?: string;
  snippet?: string;
  date?: string;
  imageUrl?: string;
}

export class SerperSource implements SearchSource {
  readonly name = "serper";
  readonly lenses = "*" as const;
  readonly costPerThousand = 1;

  #config: SerperConfig;
  #baseUrl: string;

  constructor(config: SerperConfig) {
    this.#config = config;
    this.#baseUrl = (config.baseUrl ?? "https://google.serper.dev").replace(/\/+$/, "");
  }

  async search(request: SearchRequest): Promise<Candidate[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#config.timeoutMs ?? 2_500);
    request.signal?.addEventListener("abort", () => controller.abort(), { once: true });

    const body: Record<string, unknown> = {
      q: request.query,
      num: Math.min(20, Math.max(1, request.limit)),
    };
    if (request.locale) {
      const [language, country] = request.locale.split("-");
      if (language) body.hl = language.toLowerCase();
      if (country) body.gl = country.toLowerCase();
    }
    if (request.intent === "news") body.tbs = "qdr:w";

    try {
      const response = await this.#config.fetch(`${this.#baseUrl}/search`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.#config.apiKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) throw new SourceError(`HTTP ${response.status}`, this.name);

      const json = (await response.json()) as { organic?: SerperOrganic[] };
      return (json.organic ?? []).flatMap((result, index) => {
        if (!result.link) return [];
        const domain = domainOf(result.link);
        if (!domain) return [];
        return [
          {
            url: result.link,
            title: result.title ?? domain,
            snippet: result.snippet ?? "",
            domain,
            sources: [this.name],
            rank: index,
            ...(result.imageUrl ? { imageUrl: result.imageUrl } : {}),
            ...(result.date ? { publishedAt: result.date } : {}),
          } satisfies Candidate,
        ];
      });
    } catch (error) {
      if (error instanceof SourceError) throw error;
      throw new SourceError(`request failed: ${String(error)}`, this.name, error);
    } finally {
      clearTimeout(timer);
    }
  }
}
