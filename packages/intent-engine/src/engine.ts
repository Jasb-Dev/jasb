/**
 * The engine.
 *
 * One call, `resolve()`, runs the whole pipeline and returns either a
 * destination to navigate to or a grid of cards. Every client — server, web,
 * extension, desktop — calls exactly this and renders the result.
 *
 * The ordering of the early exits is the product: a URL costs nothing, a
 * navigation hit costs nothing, a cache hit costs nothing. Only genuinely new
 * natural-language intent reaches a paid API.
 */

import { hashQuery, lookupCache, MemoryCacheStore, ttlFor } from "./cache/index.ts";
import { classify } from "./classify.ts";
import type { Decider } from "./decider/types.ts";
import {
  NavigationIndex,
  verifyDestination,
  type NavigationIndexOptions,
} from "./navigation/index.ts";
import { fallbackReason, guessIntent, judgeCandidate, planIntent } from "./pipeline.ts";
import { applyPreferences, qualityScore, type ScoreWeights } from "./quality/score.ts";
import { SeedTrackerDataset, type TrackerDataset } from "./quality/trackers.ts";
import { mergeSources } from "./sources/merge.ts";
import type { SearchSource } from "./sources/types.ts";
import type {
  Card,
  CacheStore,
  Clock,
  Embedder,
  FetchLike,
  Logger,
  PreferenceStore,
  QualitySignals,
  ResolveOptions,
  ResolveResult,
} from "./types.ts";

export interface EngineConfig {
  decider: Decider;
  sources: SearchSource[];
  fetch: FetchLike;

  cache?: CacheStore;
  preferences?: PreferenceStore;
  embedder?: Embedder;
  trackers?: TrackerDataset;
  logger?: Logger;
  clock?: Clock;

  navigation?: NavigationIndexOptions | NavigationIndex | false;

  /** Candidates pulled from the sources before ranking. Default 20. */
  candidatePool?: number;
  /** Cards returned at full confidence. Default 6. */
  maxCards?: number;
  /**
   * Below this mean relevance confidence we show fewer cards rather than
   * pretending. Calibrated probabilities are what make this honest — an
   * ordinary LLM is confidently wrong at the same rate it is confidently right.
   */
  lowConfidenceThreshold?: number;
  /** Hard ceiling for the source fan-out. Default 2500 ms. */
  sourceDeadlineMs?: number;
  /** Grace period for stragglers after the first source delivers. Default 400 ms. */
  sourceGraceMs?: number;
  /** Verify a navigation-index guess with a HEAD request. Default true. */
  verifyNavigation?: boolean;
  weights?: ScoreWeights;
}

const NO_OP_LOGGER: Logger = {
  debug: () => {},
  warn: () => {},
  error: () => {},
};

export class IntentEngine {
  #config: EngineConfig;
  #cache: CacheStore;
  #navigation: NavigationIndex | undefined;
  #trackers: TrackerDataset;
  #logger: Logger;
  #clock: Clock;

  constructor(config: EngineConfig) {
    this.#config = config;
    this.#cache = config.cache ?? new MemoryCacheStore();
    this.#trackers = config.trackers ?? new SeedTrackerDataset();
    this.#logger = config.logger ?? NO_OP_LOGGER;
    this.#clock = config.clock ?? { now: () => Date.now() };

    if (config.navigation === false) {
      this.#navigation = undefined;
    } else if (config.navigation instanceof NavigationIndex) {
      this.#navigation = config.navigation;
    } else {
      this.#navigation = new NavigationIndex(config.navigation ?? {});
    }
  }

  async resolve(input: string, options: ResolveOptions = {}): Promise<ResolveResult> {
    const started = this.#clock.now();
    const timings: Record<string, number> = {};
    const mark = (stage: string, from: number) => {
      timings[stage] = this.#clock.now() - from;
    };

    // ---- 1. Already a destination? -----------------------------------------
    const classification = classify(input);
    if (classification.kind === "url") {
      return {
        kind: "navigate",
        url: classification.url,
        via: "url",
        confidence: 1,
        tookMs: this.#clock.now() - started,
      };
    }
    if (classification.kind === "bang") {
      return {
        kind: "navigate",
        url: classification.url,
        via: "bang",
        confidence: 1,
        tookMs: this.#clock.now() - started,
      };
    }

    const query = classification.query;
    if (!query) {
      return {
        kind: "cards",
        query: "",
        intent: "research",
        lens: "general",
        cards: [],
        cached: false,
        lowConfidence: false,
        tookMs: this.#clock.now() - started,
        timings,
      };
    }

    // ---- 2. Navigation index ------------------------------------------------
    if (this.#navigation) {
      const navStart = this.#clock.now();
      const hit = this.#navigation.lookup(query);
      if (hit) {
        const verified =
          this.#config.verifyNavigation === false ||
          (await verifyDestination(hit.url, this.#config.fetch));
        mark("navigation", navStart);
        if (verified) {
          this.#logger.debug("navigation index hit", { query, url: hit.url });
          return {
            kind: "navigate",
            url: hit.url,
            via: "navigation-index",
            confidence: hit.confidence,
            tookMs: this.#clock.now() - started,
          };
        }
        this.#logger.warn("navigation candidate failed verification", { url: hit.url });
      } else {
        mark("navigation", navStart);
      }
    }

    // ---- 3. Cache -----------------------------------------------------------
    const preferences = await this.#loadPreferences();

    if (!options.refresh) {
      const cacheStart = this.#clock.now();
      const hit = await lookupCache({
        store: this.#cache,
        query,
        now: this.#clock.now(),
        embedder: this.#config.embedder,
        decider: this.#config.decider,
        logger: this.#logger,
        signal: options.signal,
      }).catch((error) => {
        this.#logger.warn("cache lookup failed", { error: String(error) });
        return undefined;
      });
      mark("cache", cacheStart);

      if (hit) {
        // Preferences are re-applied on every read: the cached list is the
        // anonymous part, the ordering is personal and stays on this device.
        const cards = applyPreferences(hit.entry.cards, preferences) as Card[];
        return {
          kind: "cards",
          query,
          intent: hit.entry.intent,
          lens: hit.entry.lens,
          cards: cards.slice(0, options.maxCards ?? this.#config.maxCards ?? 6),
          cached: true,
          lowConfidence: false,
          tookMs: this.#clock.now() - started,
          timings,
        };
      }
    }

    // ---- 4. Intent + lens ---------------------------------------------------
    const planStart = this.#clock.now();
    let plan;
    try {
      plan = await planIntent(query, this.#config.decider, options.signal);
    } catch (error) {
      this.#logger.warn("intent planning failed; using keyword heuristic", {
        error: String(error),
      });
      plan = guessIntent(query);
    }
    mark("plan", planStart);

    // ---- 5. Sources ---------------------------------------------------------
    const searchStart = this.#clock.now();
    const poolSize = this.#config.candidatePool ?? 20;
    const merged = await mergeSources({
      sources: this.#config.sources,
      request: {
        query,
        limit: poolSize,
        intent: plan.intent,
        lens: plan.lens,
        ...(options.locale ? { locale: options.locale } : {}),
        ...(options.region ? { region: options.region } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      },
      deadlineMs: this.#config.sourceDeadlineMs ?? 2_500,
      ...(this.#config.sourceGraceMs !== undefined
        ? { graceMs: this.#config.sourceGraceMs }
        : {}),
      logger: this.#logger,
    });
    mark("search", searchStart);

    if (merged.candidates.length === 0) {
      this.#logger.error("no candidates from any source", { query, failed: merged.failed });
      return {
        kind: "cards",
        query,
        intent: plan.intent,
        lens: plan.lens,
        cards: [],
        cached: false,
        lowConfidence: true,
        tookMs: this.#clock.now() - started,
        timings,
      };
    }

    // ---- 6. Rerank ----------------------------------------------------------
    const rankStart = this.#clock.now();
    const candidates = merged.candidates.slice(0, poolSize);
    const localSignals = await this.#loadDomainSignals(candidates.map((c) => c.domain));

    // One judgement per candidate, all in flight at once. A candidate whose
    // judgement fails keeps neutral values rather than dropping out — losing a
    // good result to a transient error would be worse than ranking it blind.
    const judgements = await Promise.all(
      candidates.map(async (candidate) => {
        try {
          return await judgeCandidate(
            query,
            plan.intent,
            candidate,
            this.#config.decider,
            options.signal,
          );
        } catch (error) {
          this.#logger.warn("candidate judgement failed", {
            url: candidate.url,
            error: String(error),
          });
          return {
            relevance: 0.5,
            spamProbability: 0.2,
            confidence: 0.2,
            reason: fallbackReason(candidate, plan.intent),
          };
        }
      }),
    );
    mark("rerank", rankStart);

    const scored = candidates.map((candidate, index) => {
      const judgement = judgements[index]!;
      const signals: QualitySignals = {
        ...localSignals[candidate.domain],
        relevance: judgement.relevance,
        spamProbability: judgement.spamProbability,
      };

      const trackers = signals.trackers ?? this.#trackers.lookup(candidate.domain);
      if (trackers !== undefined) signals.trackers = trackers;
      if (candidate.sources.includes("marginalia")) signals.smallWeb = true;

      const card: Card = {
        url: candidate.url,
        title: candidate.title,
        domain: candidate.domain,
        reason: judgement.reason,
        score: qualityScore({
          candidate,
          signals,
          sourceCount: merged.used.length,
          ...(this.#config.weights ? { weights: this.#config.weights } : {}),
        }),
        confidence: judgement.confidence,
        signals,
        ...(candidate.imageUrl ? { thumbnailUrl: candidate.imageUrl } : {}),
        faviconUrl: faviconFor(candidate.domain),
      };
      return card;
    });

    // ---- 7. Cut ------------------------------------------------------------
    const meanConfidence =
      scored.reduce((sum, card) => sum + card.confidence, 0) / (scored.length || 1);
    const threshold = this.#config.lowConfidenceThreshold ?? 0.55;
    const lowConfidence = meanConfidence < threshold;

    const requested = options.maxCards ?? this.#config.maxCards ?? 6;
    // Being unsure and saying so beats padding the grid with filler.
    const limit = lowConfidence ? Math.max(3, Math.floor(requested / 2)) : requested;

    const ordered = applyPreferences(scored, preferences) as Card[];
    const cards = ordered.slice(0, limit);

    // ---- 8. Store ----------------------------------------------------------
    const now = this.#clock.now();
    // What goes in the cache is the *unpersonalised* list, ranked by quality
    // alone. This device's block and pin rules are re-applied on every read, so
    // a shared cache entry never carries one user's preferences to another.
    const anonymous = [...scored].sort((a, b) => b.score - a.score);
    void this.#cache
      .set({
        query,
        hash: hashQuery(query),
        intent: plan.intent,
        lens: plan.lens,
        cards: anonymous,
        storedAt: now,
        expiresAt: now + ttlFor(plan.intent),
        ...(await this.#maybeEmbed(query)),
      })
      .catch((error) => this.#logger.warn("cache write failed", { error: String(error) }));

    return {
      kind: "cards",
      query,
      intent: plan.intent,
      lens: plan.lens,
      cards,
      cached: false,
      lowConfidence,
      tookMs: this.#clock.now() - started,
      timings,
    };
  }

  async #loadPreferences(): Promise<{ blocked: Set<string>; pinned: Set<string> }> {
    const store = this.#config.preferences;
    if (!store) return { blocked: new Set(), pinned: new Set() };
    try {
      const [blocked, pinned] = await Promise.all([store.blockedDomains(), store.pinnedDomains()]);
      return { blocked: new Set(blocked), pinned: new Set(pinned) };
    } catch (error) {
      this.#logger.warn("preference load failed", { error: String(error) });
      return { blocked: new Set(), pinned: new Set() };
    }
  }

  async #loadDomainSignals(domains: string[]): Promise<Record<string, QualitySignals>> {
    const store = this.#config.preferences;
    if (!store?.domainSignals) return {};
    try {
      return await store.domainSignals([...new Set(domains)]);
    } catch (error) {
      this.#logger.warn("domain signal load failed", { error: String(error) });
      return {};
    }
  }

  async #maybeEmbed(query: string): Promise<{ embedding?: number[] }> {
    if (!this.#config.embedder) return {};
    try {
      return { embedding: await this.#config.embedder.embed(query) };
    } catch {
      return {};
    }
  }
}

/**
 * Favicon URL.
 *
 * Served from the site itself, not a third-party favicon proxy: routing every
 * result's icon through Google or DuckDuckGo would leak the shape of the user's
 * search to exactly the parties this product exists to avoid.
 */
function faviconFor(domain: string): string {
  return `https://${domain}/favicon.ico`;
}
