/**
 * @jasb/intent-engine — the search brain of Jasb.
 *
 * Pure TypeScript, zero runtime dependencies, no I/O of its own. Every
 * capability it needs (network, storage, preferences, embeddings, clock) is
 * injected by the host, which is what lets the server, the web app, the Chrome
 * extension and the Electron shell all run byte-identical ranking logic.
 */

export * from "./types.ts";
export * from "./classify.ts";
export * from "./engine.ts";
export * from "./pipeline.ts";

export * from "./decider/types.ts";
export {
  SystemOneDecider,
  normaliseAnswer,
  SYSTEM_ONE_PRESETS,
  type SystemOneConfig,
  type SystemOnePreset,
} from "./decider/systemone.ts";
export { LayaDecider, layaServerDecider, type LayaLocalConfig, type LayaRuntime } from "./decider/laya.ts";
export { LlmDecider, type LlmConfig, type LlmProvider } from "./decider/llm.ts";
export { AutoDecider, type AutoDeciderOptions } from "./decider/auto.ts";

export * from "./sources/types.ts";
export { BraveSource, type BraveConfig } from "./sources/brave.ts";
export { SearxngSource, type SearxngConfig } from "./sources/searxng.ts";
export { SerperSource, type SerperConfig } from "./sources/serper.ts";
export {
  WikipediaSource,
  MarginaliaSource,
  type WikipediaConfig,
  type MarginaliaConfig,
} from "./sources/vertical.ts";
export { mergeSources, dedupe, type MergeOptions, type MergeResult } from "./sources/merge.ts";

export {
  qualityScore,
  applyPreferences,
  trackerScore,
  speedScore,
  DEFAULT_WEIGHTS,
  type ScoreWeights,
  type ScoreInput,
} from "./quality/score.ts";
export {
  SeedTrackerDataset,
  mergeTrackerSources,
  type TrackerDataset,
} from "./quality/trackers.ts";

export {
  MemoryCacheStore,
  lookupCache,
  hashQuery,
  cosineSimilarity,
  ttlFor,
  TTL_BY_INTENT,
  type CacheHit,
  type CacheLookupOptions,
} from "./cache/index.ts";

export {
  NavigationIndex,
  verifyDestination,
  type NavigationEntry,
  type NavigationHit,
  type NavigationIndexOptions,
} from "./navigation/index.ts";

/** Bumped whenever ranking changes, so the golden-set CI job can pin a version. */
export const ENGINE_VERSION = "0.1.0";
