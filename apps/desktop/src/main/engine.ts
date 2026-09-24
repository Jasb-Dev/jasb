/**
 * Builds the engine for the desktop app.
 *
 * The desktop build runs the engine *in process* rather than calling a server.
 * That is the point of it: with your own keys, a query never touches our
 * infrastructure at all — it goes from this machine straight to the providers
 * you chose.
 */

import {
  AutoDecider,
  BraveSource,
  IntentEngine,
  SystemOneDecider,
  LlmDecider,
  MarginaliaSource,
  SearxngSource,
  WikipediaSource,
  type Decider,
  type Logger,
  type SearchSource,
} from "@jasb/intent-engine";

import type { KeyVault } from "./keys.ts";
import type { LocalStore } from "./store.ts";

const logger: Logger = {
  debug: () => {},
  warn: (message, data) => console.warn(`[jasb] ${message}`, data ?? {}),
  error: (message, data) => console.error(`[jasb] ${message}`, data ?? {}),
};

/**
 * A decider that always fails.
 *
 * Used when the user has configured no keys. The engine's own fallbacks take
 * over — keyword intent detection and structural reason labels — so a fresh
 * install still returns useful cards from the free sources before the user has
 * entered anything.
 */
const NO_DECIDER: Decider = {
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

export function buildEngine(vault: KeyVault, store: LocalStore): IntentEngine {
  const keys = vault.read();
  const fetchLike = globalThis.fetch as never;

  const deciders: Decider[] = [];
  if (keys.systemOneUrl) {
    // A self-hosted open decision model. Everything stays on the user's own
    // machine or network — this is the strongest privacy configuration the
    // product offers.
    deciders.push(
      new SystemOneDecider({
        fetch: fetchLike,
        baseUrl: keys.systemOneUrl,
        ...(keys.systemOneModel ? { model: keys.systemOneModel } : {}),
        ...(keys.systemOneApiKey ? { apiKey: keys.systemOneApiKey } : {}),
      }),
    );
  }
  if (keys.llmApiKey || keys.llmProvider === "ollama") {
    deciders.push(
      new LlmDecider({
        provider: keys.llmProvider ?? "anthropic",
        apiKey: keys.llmApiKey ?? "",
        fetch: fetchLike,
        ...(keys.llmModel ? { model: keys.llmModel } : {}),
      }),
    );
  }

  const sources: SearchSource[] = [];
  if (keys.braveApiKey) {
    sources.push(new BraveSource({ apiKey: keys.braveApiKey, fetch: fetchLike }));
  }
  if (keys.searxngUrl) {
    sources.push(new SearxngSource({ baseUrl: keys.searxngUrl, fetch: fetchLike }));
  }
  // Free verticals cost nothing and work with no configuration at all.
  sources.push(new WikipediaSource({ fetch: fetchLike }));
  sources.push(new MarginaliaSource({ fetch: fetchLike }));

  return new IntentEngine({
    decider:
      deciders.length === 0
        ? NO_DECIDER
        : deciders.length === 1
          ? deciders[0]!
          : new AutoDecider(deciders, { logger }),
    sources,
    fetch: fetchLike,
    cache: store.cacheStore(),
    preferences: store.preferenceStore(),
    logger,
  });
}
