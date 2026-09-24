/**
 * SearxNG — the free, self-hosted metasearch fallback.
 *
 * This is the r/selfhosted path: point it at your own instance and the product
 * costs nothing per query. It is also the backstop if a paid provider changes
 * its pricing or terms overnight.
 *
 * Note that the instance must have the JSON output format enabled in
 * `settings.yml` (`search.formats: [html, json]`) — it is off by default.
 */

import { domainOf } from "../classify.ts";
import type { Candidate, FetchLike } from "../types.ts";
import { SourceError, type SearchRequest, type SearchSource } from "./types.ts";

export interface SearxngConfig {
  /** Base URL of your instance, e.g. `http://127.0.0.1:8888`. */
  baseUrl: string;
  fetch: FetchLike;
  timeoutMs?: number;
  /** Restrict to specific upstream engines, e.g. `["duckduckgo", "mojeek"]`. */
  engines?: string[];
}

interface SearxngResult {
  url?: string;
  title?: string;
  content?: string;
  publishedDate?: string;
  img_src?: string;
  thumbnail?: string;
}

export class SearxngSource implements SearchSource {
  readonly name = "searxng";
  readonly lenses = "*" as const;
  readonly costPerThousand = 0;

  #config: SearxngConfig;
  #baseUrl: string;

  constructor(config: SearxngConfig) {
    this.#config = config;
    this.#baseUrl = config.baseUrl.replace(/\/+$/, "");
  }

  async search(request: SearchRequest): Promise<Candidate[]> {
    const params = new URLSearchParams({
      q: request.query,
      format: "json",
      safesearch: "1",
    });
    if (this.#config.engines?.length) params.set("engines", this.#config.engines.join(","));
    if (request.locale) params.set("language", request.locale);
    if (request.intent === "news") params.set("time_range", "week");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#config.timeoutMs ?? 3_000);
    request.signal?.addEventListener("abort", () => controller.abort(), { once: true });

    try {
      const response = await this.#config.fetch(`${this.#baseUrl}/search?${params.toString()}`, {
        headers: { accept: "application/json" },
        signal: controller.signal,
      });

      if (!response.ok) {
        const hint =
          response.status === 403
            ? " (enable the `json` format in settings.yml)"
            : "";
        throw new SourceError(`HTTP ${response.status}${hint}`, this.name);
      }

      const json = (await response.json()) as { results?: SearxngResult[] };
      return (json.results ?? []).slice(0, request.limit).flatMap((result, index) => {
        if (!result.url) return [];
        const domain = domainOf(result.url);
        if (!domain) return [];
        const image = result.thumbnail ?? result.img_src;
        return [
          {
            url: result.url,
            title: result.title ?? domain,
            snippet: result.content ?? "",
            domain,
            sources: [this.name],
            rank: index,
            ...(image ? { imageUrl: image } : {}),
            ...(result.publishedDate ? { publishedAt: result.publishedDate } : {}),
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
