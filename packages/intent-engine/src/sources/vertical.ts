/**
 * Vertical sources — free, focused, and worth one card each.
 *
 * Kagi enriches a general index with Wikipedia, Wolfram and friends; these are
 * our equivalents. Both are free and rate-limit-friendly, so they run in
 * parallel with the paid general index rather than instead of it.
 */

import { domainOf } from "../classify.ts";
import type { Candidate, FetchLike, Lens } from "../types.ts";
import { SourceError, type SearchRequest, type SearchSource } from "./types.ts";

// ---------------------------------------------------------------------------
// Wikipedia
// ---------------------------------------------------------------------------

export interface WikipediaConfig {
  fetch: FetchLike;
  /** Language subdomain. Defaults to `en`. */
  language?: string;
  timeoutMs?: number;
}

interface WikipediaSearchPage {
  key?: string;
  title?: string;
  description?: string;
  excerpt?: string;
  thumbnail?: { url?: string };
}

export class WikipediaSource implements SearchSource {
  readonly name = "wikipedia";
  readonly lenses: readonly Lens[] = ["general", "academic", "smallweb", "news"];
  readonly costPerThousand = 0;

  #config: WikipediaConfig;
  #language: string;

  constructor(config: WikipediaConfig) {
    this.#config = config;
    this.#language = config.language ?? "en";
  }

  async search(request: SearchRequest): Promise<Candidate[]> {
    // One reference card is the point — more would crowd out the open web.
    // A short query ("tardigrade", "rust ownership") may deserve two. A
    // sentence does not: Wikipedia matches its words, not its meaning, so
    // "how do tardigrades survive vacuum" returns *Tardigrade* and then
    // *Vacuum*, and the second card reads as if we split the question.
    const words = request.query.trim().split(/\s+/).filter(Boolean).length;
    const limit = Math.min(words > 3 ? 1 : 2, request.limit);
    const url =
      `https://${this.#language}.wikipedia.org/w/rest.php/v1/search/page` +
      `?q=${encodeURIComponent(request.query)}&limit=${limit}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#config.timeoutMs ?? 2_000);
    request.signal?.addEventListener("abort", () => controller.abort(), { once: true });

    try {
      const response = await this.#config.fetch(url, {
        headers: { accept: "application/json", "user-agent": USER_AGENT },
        signal: controller.signal,
      });
      if (!response.ok) throw new SourceError(`HTTP ${response.status}`, this.name);

      const json = (await response.json()) as { pages?: WikipediaSearchPage[] };
      return (json.pages ?? []).flatMap((page, index) => {
        if (!page.key) return [];
        const articleUrl = `https://${this.#language}.wikipedia.org/wiki/${encodeURIComponent(page.key)}`;
        return [
          {
            url: articleUrl,
            title: page.title ?? page.key.replace(/_/g, " "),
            snippet: stripHighlight(page.excerpt ?? page.description ?? ""),
            domain: `${this.#language}.wikipedia.org`,
            sources: [this.name],
            rank: index,
            ...(page.thumbnail?.url
              ? { imageUrl: absolutise(page.thumbnail.url) }
              : {}),
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

// ---------------------------------------------------------------------------
// Marginalia — the small web
// ---------------------------------------------------------------------------

export interface MarginaliaConfig {
  fetch: FetchLike;
  /** Marginalia's public demo key. Get your own for anything beyond testing. */
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
}

interface MarginaliaResult {
  url?: string;
  title?: string;
  description?: string;
  quality?: number;
}

export class MarginaliaSource implements SearchSource {
  readonly name = "marginalia";
  readonly lenses: readonly Lens[] = ["smallweb", "general", "academic", "forums"];
  readonly costPerThousand = 0;

  #config: MarginaliaConfig;
  #baseUrl: string;

  constructor(config: MarginaliaConfig) {
    this.#config = config;
    this.#baseUrl = (config.baseUrl ?? "https://api.marginalia.nu").replace(/\/+$/, "");
  }

  async search(request: SearchRequest): Promise<Candidate[]> {
    const key = this.#config.apiKey ?? "public";
    const url = `${this.#baseUrl}/${key}/search/${encodeURIComponent(request.query)}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#config.timeoutMs ?? 2_500);
    request.signal?.addEventListener("abort", () => controller.abort(), { once: true });

    try {
      const response = await this.#config.fetch(url, {
        headers: { accept: "application/json", "user-agent": USER_AGENT },
        signal: controller.signal,
      });
      if (!response.ok) throw new SourceError(`HTTP ${response.status}`, this.name);

      const json = (await response.json()) as { results?: MarginaliaResult[] };
      // Small web earns at most two cards — it is a spice, not the meal.
      return (json.results ?? []).slice(0, Math.min(2, request.limit)).flatMap((result, index) => {
        if (!result.url) return [];
        const domain = domainOf(result.url);
        if (!domain) return [];
        return [
          {
            url: result.url,
            title: result.title ?? domain,
            snippet: result.description ?? "",
            domain,
            sources: [this.name],
            rank: index,
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

const USER_AGENT = "Jasb/0.1 (+https://jasb.dev)";

function stripHighlight(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function absolutise(url: string): string {
  return url.startsWith("//") ? `https:${url}` : url;
}
