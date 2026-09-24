/**
 * Builds the engine for a request.
 *
 * Two modes:
 *
 *   - **Server mode** — our keys, our quota, our shared cache. The user is
 *     anonymous to us: we see a query and a device token hash, never both tied
 *     to an identity.
 *   - **BYOK** — the client sends its own provider keys per request. We hold
 *     nothing, we cache nothing shared, and the keys exist only for the
 *     lifetime of the call.
 */

import {
  AutoDecider,
  BraveSource,
  IntentEngine,
  SystemOneDecider,
  LlmDecider,
  MarginaliaSource,
  MemoryCacheStore,
  SearxngSource,
  SerperSource,
  WikipediaSource,
  type Decider,
  type Logger,
  type SearchSource,
} from "@jasb/intent-engine";

import type { ServerConfig } from "./config.ts";

/** Per-request key overrides. Present only in BYOK mode. */
export interface ByokKeys {
  systemOneUrl?: string;
  systemOneApiKey?: string;
  systemOneModel?: string;
  llmProvider?: "anthropic" | "openai" | "openrouter" | "gemini" | "ollama";
  llmApiKey?: string;
  llmModel?: string;
  llmBaseUrl?: string;
  braveApiKey?: string;
  searxngUrl?: string;
}

/**
 * Structured logger that never sees a query.
 *
 * The privacy label promises we do not log search content. The cleanest way to
 * keep that promise is to make it impossible here rather than to remember it at
 * every call site: anything that looks like user text is dropped before output.
 */
export const privacyLogger: Logger = {
  debug: () => {},
  warn: (message, data) => console.warn(`[warn] ${message}`, redact(data)),
  error: (message, data) => console.error(`[error] ${message}`, redact(data)),
};

const SENSITIVE_KEYS = new Set(["query", "q", "cached", "newQuery", "cachedQuery", "text", "url"]);

function redact(data?: Record<string, unknown>): Record<string, unknown> {
  if (!data) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    out[key] = SENSITIVE_KEYS.has(key) ? "[redacted]" : value;
  }
  return out;
}

/** The shared, anonymous cache. Query hash → card list; no device is recorded. */
export const sharedCache = new MemoryCacheStore({ maxEntries: 5_000 });

export function buildDecider(config: ServerConfig, byok?: ByokKeys): Decider | undefined {
  const chain: Decider[] = [];
  const llmKey = byok?.llmApiKey ?? config.llmApiKey;
  const llmProvider = byok?.llmProvider ?? config.llmProvider ?? "anthropic";

  const systemOneUrl = byok?.systemOneUrl ?? config.systemOneUrl;
  if (systemOneUrl || config.systemOnePreset) {
    chain.push(
      new SystemOneDecider({
        fetch: globalThis.fetch as never,
        ...(config.systemOnePreset ? { preset: config.systemOnePreset } : {}),
        ...(systemOneUrl ? { baseUrl: systemOneUrl } : {}),
        ...(byok?.systemOneModel ?? config.systemOneModel
          ? { model: byok?.systemOneModel ?? config.systemOneModel }
          : {}),
        ...(byok?.systemOneApiKey ?? config.systemOneApiKey
          ? { apiKey: byok?.systemOneApiKey ?? config.systemOneApiKey }
          : {}),
      }),
    );
  }

  if (llmKey) {
    chain.push(
      new LlmDecider({
        provider: llmProvider,
        apiKey: llmKey,
        fetch: globalThis.fetch as never,
        ...(byok?.llmModel ?? config.llmModel
          ? { model: byok?.llmModel ?? config.llmModel }
          : {}),
        ...(byok?.llmBaseUrl ? { baseUrl: byok.llmBaseUrl } : {}),
      }),
    );
  }

  if (chain.length === 0) return undefined;
  if (chain.length === 1) return chain[0];
  return new AutoDecider(chain, { logger: privacyLogger });
}

export interface BuildOptions {
  /**
   * Skip every source that costs money. Set when the daily ceiling is spent:
   * the free indexes still answer, so the product degrades rather than fails.
   */
  freeSourcesOnly?: boolean;
}

export function buildSources(
  config: ServerConfig,
  byok?: ByokKeys,
  options: BuildOptions = {},
): SearchSource[] {
  const fetch = globalThis.fetch as never;
  const sources: SearchSource[] = [];

  // A user's own key is their own spend, so the ceiling does not apply to it.
  const paidAllowed = !options.freeSourcesOnly || Boolean(byok);

  const braveKey = byok?.braveApiKey ?? config.braveApiKey;
  if (braveKey && paidAllowed) sources.push(new BraveSource({ apiKey: braveKey, fetch }));

  // SearxNG is free to call whoever is paying, so it survives the ceiling.
  const searxngUrl = byok?.searxngUrl ?? config.searxngUrl;
  if (searxngUrl) sources.push(new SearxngSource({ baseUrl: searxngUrl, fetch }));

  // Serper is Google-derived; it stays behind an explicit opt-in and never runs
  // as the only general index.
  if (config.serperApiKey && paidAllowed && sources.length > 0) {
    sources.push(new SerperSource({ apiKey: config.serperApiKey, fetch }));
  }

  // Free verticals — always on, they cost nothing and sharpen the grid.
  sources.push(new WikipediaSource({ fetch }));
  sources.push(
    new MarginaliaSource({
      fetch,
      ...(config.marginaliaApiKey ? { apiKey: config.marginaliaApiKey } : {}),
    }),
  );

  return sources;
}

/**
 * A decider that answers nothing.
 *
 * When no keys are configured at all, the engine's own fallbacks take over:
 * keyword intent detection and structural reason labels. The product stays
 * usable for a contributor who just cloned the repo.
 */
const NULL_DECIDER: Decider = {
  name: "none",
  ask: async () => {
    throw new Error("no decider configured");
  },
  choose: async () => {
    throw new Error("no decider configured");
  },
  score: async () => {
    throw new Error("no decider configured");
  },
  yesNo: async () => {
    throw new Error("no decider configured");
  },
};

export function buildEngine(
  config: ServerConfig,
  byok?: ByokKeys,
  options: BuildOptions = {},
): IntentEngine {
  // Past the ceiling the decision layer comes out too — the engine's keyword
  // fallback and structural labels still produce a usable grid.
  const decider = options.freeSourcesOnly && !byok ? undefined : buildDecider(config, byok);

  return new IntentEngine({
    decider: decider ?? NULL_DECIDER,
    sources: buildSources(config, byok, options),
    fetch: globalThis.fetch as never,
    // BYOK requests never touch the shared cache: those queries went to the
    // user's own providers and are none of our business.
    ...(byok ? {} : { cache: sharedCache }),
    logger: privacyLogger,
  });
}
