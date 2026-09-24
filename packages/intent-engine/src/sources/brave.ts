/**
 * Brave Search — the default general index.
 *
 * Independent index (not a Google scrape, so no SerpApi-style legal exposure),
 * ~630 ms median, $0.003–0.005 per query. Attribution is required by the terms
 * of service; the UI shows it in the settings panel.
 */

import { domainOf } from "../classify.ts";
import type { Candidate, FetchLike } from "../types.ts";
import { SourceError, type SearchRequest, type SearchSource } from "./types.ts";

export interface BraveConfig {
  apiKey: string;
  fetch: FetchLike;
  baseUrl?: string;
  timeoutMs?: number;
}

interface BraveWebResult {
  url?: string;
  title?: string;
  description?: string;
  age?: string;
  page_age?: string;
  language?: string;
  thumbnail?: { src?: string };
  meta_url?: { hostname?: string };
}

export class BraveSource implements SearchSource {
  readonly name = "brave";
  readonly lenses = "*" as const;
  readonly costPerThousand = 5;

  #config: BraveConfig;
  #baseUrl: string;

  constructor(config: BraveConfig) {
    this.#config = config;
    this.#baseUrl = (config.baseUrl ?? "https://api.search.brave.com").replace(/\/+$/, "");
  }

  async search(request: SearchRequest): Promise<Candidate[]> {
    const params = new URLSearchParams({
      q: request.query,
      // Brave caps `count` at 20, which is exactly our candidate pool size.
      count: String(Math.min(20, Math.max(1, request.limit))),
      safesearch: "moderate",
      text_decorations: "false",
      spellcheck: "1",
    });
    if (request.locale) {
      const [language, country] = request.locale.split("-");
      if (language) params.set("search_lang", language.toLowerCase());
      if (country) params.set("country", country.toUpperCase());
    }
    // News decays fast; everything else is fine with Brave's default freshness.
    if (request.intent === "news") params.set("freshness", "pw");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#config.timeoutMs ?? 2_500);
    request.signal?.addEventListener("abort", () => controller.abort(), { once: true });

    try {
      const response = await this.#config.fetch(
        `${this.#baseUrl}/res/v1/web/search?${params.toString()}`,
        {
          headers: {
            accept: "application/json",
            "accept-encoding": "gzip",
            "x-subscription-token": this.#config.apiKey,
          },
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new SourceError(`HTTP ${response.status}: ${detail.slice(0, 200)}`, this.name);
      }

      const json = (await response.json()) as { web?: { results?: BraveWebResult[] } };
      return (json.web?.results ?? []).flatMap((result, index) =>
        toCandidate(result, index, this.name),
      );
    } catch (error) {
      if (error instanceof SourceError) throw error;
      throw new SourceError(`request failed: ${String(error)}`, this.name, error);
    } finally {
      clearTimeout(timer);
    }
  }
}

function toCandidate(result: BraveWebResult, index: number, source: string): Candidate[] {
  if (!result.url) return [];
  const domain = result.meta_url?.hostname?.replace(/^www\./, "") || domainOf(result.url);
  if (!domain) return [];

  return [
    {
      url: result.url,
      title: stripTags(result.title ?? domain),
      snippet: stripTags(result.description ?? ""),
      domain,
      sources: [source],
      rank: index,
      ...(result.thumbnail?.src ? { imageUrl: result.thumbnail.src } : {}),
      ...(result.page_age ? { publishedAt: result.page_age } : {}),
      ...(result.language ? { language: result.language } : {}),
    },
  ];
}

/** Brave can return `<strong>` highlights even with `text_decorations=false`. */
function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}
