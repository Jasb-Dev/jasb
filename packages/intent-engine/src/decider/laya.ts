/**
 * Laya — the open-weight, Jev-compatible decision model.
 *
 * Two ways to reach it, both exposed here:
 *
 *   1. `LayaDecider` runs the ONNX weights in-process via `@receptron/laya`.
 *      Fully offline, zero API cost, but the fp32 weights are ~1.7 GB on first
 *      use — so it is an opt-in download, never the default.
 *   2. `layaServerDecider()` talks to a self-hosted server that speaks Jev's
 *      wire protocol. Same normalisation, no local download.
 *
 * The independent benchmarks are mixed: the specialised `typed-decisions`
 * checkpoint is strong, the general English one is not. Treat this as the
 * privacy/offline path and the bulk-classification path, not as a drop-in
 * replacement for the hosted decider. Pin `modelRevision` — the model ships
 * breaking changes on a weekly cadence.
 */

import type { FetchLike } from "../types.ts";
import { normaliseAnswer, SystemOneDecider } from "./systemone.ts";
import {
  DeciderError,
  type Answer,
  type ChoiceAnswer,
  type ChoiceQuestion,
  type Decider,
  type NoulAnswer,
  type NoulQuestion,
  type Question,
  type ScoreAnswer,
  type ScoreQuestion,
} from "./types.ts";

export interface LayaLocalConfig {
  /** Hugging Face revision or commit SHA. Pin it — outputs shift between releases. */
  modelRevision?: string;
  /** `typed-decisions` is the only checkpoint that benchmarks well for our tasks. */
  checkpoint?: "typed-decisions" | "english" | "multilingual";
  /** Injected for tests; defaults to a dynamic import of `@receptron/laya`. */
  loader?: () => Promise<LayaRuntime>;
}

/** The slice of `@receptron/laya` we depend on. */
export interface LayaRuntime {
  systemOne(
    state: unknown,
    questions: Record<string, Question>,
  ): Promise<{ answers: Record<string, unknown>; usage?: { input_tokens?: number } }>;
}

/** Laya's English checkpoint caps at 512 tokens, so states must stay small. */
const MAX_STATE_CHARS = 1_600;

export class LayaDecider implements Decider {
  readonly name = "laya-local";

  #config: LayaLocalConfig;
  #runtime: Promise<LayaRuntime> | undefined;

  constructor(config: LayaLocalConfig = {}) {
    this.#config = config;
  }

  /** Kicks off the (large) model download so the first query doesn't pay for it. */
  async preload(): Promise<void> {
    await this.#load();
  }

  async ask(
    state: unknown,
    questions: Record<string, Question>,
  ): Promise<Record<string, Answer>> {
    const runtime = await this.#load();
    const trimmed = truncateState(state);

    let raw: { answers: Record<string, unknown> };
    try {
      raw = await runtime.systemOne(trimmed, questions);
    } catch (error) {
      throw new DeciderError(`local inference failed: ${String(error)}`, this.name, error);
    }

    const out: Record<string, Answer> = {};
    for (const [key, question] of Object.entries(questions)) {
      const answer = raw.answers?.[key];
      if (!answer || typeof answer !== "object") {
        throw new DeciderError(`missing answer for question "${key}"`, this.name, raw);
      }
      out[key] = normaliseAnswer(answer as never, question, this.name);
    }
    return out;
  }

  async choose<T extends string>(
    state: unknown,
    question: ChoiceQuestion<T>,
  ): Promise<ChoiceAnswer<T>> {
    const { only } = await this.ask(state, { only: question });
    return only as ChoiceAnswer<T>;
  }

  async score(state: unknown, question: ScoreQuestion): Promise<ScoreAnswer> {
    const { only } = await this.ask(state, { only: question });
    return only as ScoreAnswer;
  }

  async yesNo(state: unknown, question: NoulQuestion): Promise<NoulAnswer> {
    const { only } = await this.ask(state, { only: question });
    return only as NoulAnswer;
  }

  async healthy(): Promise<boolean> {
    try {
      await this.#load();
      return true;
    } catch {
      return false;
    }
  }

  #load(): Promise<LayaRuntime> {
    this.#runtime ??= (async () => {
      if (this.#config.loader) return this.#config.loader();

      // Optional dependency: only installed when the user opts into offline mode.
      const moduleName = "@receptron/laya";
      let mod: { Laya: { load(options?: unknown): Promise<LayaRuntime> } };
      try {
        mod = (await import(/* @vite-ignore */ moduleName)) as never;
      } catch (error) {
        throw new DeciderError(
          "offline mode needs `@receptron/laya`. Install it, or use the hosted decider.",
          this.name,
          error,
        );
      }
      return mod.Laya.load({
        revision: this.#config.modelRevision,
        checkpoint: this.#config.checkpoint ?? "typed-decisions",
      });
    })();

    // A failed load must not be cached forever — the user may install the dep and retry.
    return this.#runtime.catch((error) => {
      this.#runtime = undefined;
      throw error;
    });
  }
}

/**
 * Laya behind an HTTP server that speaks the System One protocol — `laya-onnx`,
 * `meldecision`, or your own wrapper.
 */
export function layaServerDecider(options: {
  baseUrl: string;
  fetch: FetchLike;
  apiKey?: string;
  timeoutMs?: number;
}): Decider {
  return new SystemOneDecider(
    {
      fetch: options.fetch,
      baseUrl: options.baseUrl,
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    },
    "laya-server",
  );
}

/** Keeps states inside Laya's 512-token window: title + meta + first paragraph is enough. */
function truncateState(state: unknown): unknown {
  if (typeof state === "string") return state.slice(0, MAX_STATE_CHARS);
  if (state && typeof state === "object" && !Array.isArray(state)) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(state)) {
      out[key] = typeof value === "string" ? value.slice(0, 400) : value;
    }
    return out;
  }
  return state;
}
