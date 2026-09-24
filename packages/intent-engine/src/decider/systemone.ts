/**
 * System One models — typed decisions instead of prose.
 *
 * TypeSafe's Jev defined the shape: you send a `state` and a map of typed
 * `questions`, and you get back calibrated probability distributions. Jev
 * itself is a closed, hosted API, but every serious open reproduction
 * implements the same `POST /v1/systemone` contract — so one client covers all
 * of them and switching is a base URL, not a rewrite.
 *
 * Wire format (verified against docs.typesafe.ai):
 *
 *   → { "state": …, "model": "kev-9b", "questions": { "k": { "type": "noul", … } } }
 *   ← { "model": "kev-9b", "answers": { "k": { "type": "noul", "noul": 0.95 } } }
 *
 * Answer field names differ per primitive — `choice`, `score`, `noul` — and are
 * *not* a generic `value`. Getting that wrong fails silently: every answer
 * falls back to its neutral default and the ranking quietly stops working.
 */

import type { FetchLike } from "../types.ts";
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

/**
 * Known implementations.
 *
 * Jev is listed but is not the default: its weights are unpublished and there
 * is no self-hosting path, so a product that depends on it depends on one
 * vendor's access policy. The open models are Apache-2.0 and run on your own
 * hardware.
 */
export const SYSTEM_ONE_PRESETS = {
  jev: {
    label: "Jev (TypeSafe AI)",
    baseUrl: "https://api.typesafe.ai",
    model: "jev-latest",
    open: false,
    note: "Hosted and proprietary. Requires an API key.",
  },
  kev: {
    label: "Kev 9B",
    baseUrl: "http://127.0.0.1:8900",
    model: "kev-9b",
    open: true,
    note: "Apache-2.0, Qwen-based. The closest open match to Jev's accuracy.",
  },
  clm: {
    label: "CLM 8B",
    baseUrl: "http://127.0.0.1:8900",
    model: "clm-8b",
    open: true,
    note: "Apache-2.0. Fastest of the open set on a single modern GPU.",
  },
  von: {
    label: "Von 395M",
    baseUrl: "http://127.0.0.1:8900",
    model: "von-395m",
    open: true,
    note: "Apache-2.0 and small enough to run on CPU.",
  },
  decider: {
    label: "Decider 2B",
    baseUrl: "http://127.0.0.1:8900",
    model: "decider-2b",
    open: true,
    note: "Apache-2.0, claims calibrated probabilities.",
  },
} as const satisfies Record<
  string,
  { label: string; baseUrl: string; model: string; open: boolean; note: string }
>;

export type SystemOnePreset = keyof typeof SYSTEM_ONE_PRESETS;

export interface SystemOneConfig {
  /** Optional for a self-hosted server that does not check authorisation. */
  apiKey?: string;
  fetch: FetchLike;
  /** Pick a known implementation; `baseUrl` and `model` still override it. */
  preset?: SystemOnePreset;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  /** Override only if a server exposes the contract on a non-standard path. */
  path?: string;
}

const DEFAULT_PATH = "/v1/systemone";
const DEFAULT_TIMEOUT_MS = 4_000;

/**
 * One answer off the wire.
 *
 * Both the canonical field (`choice` / `score` / `noul`) and the generic
 * `value` are accepted: the reproductions are young and a few of them emit the
 * generic name. Reading both costs nothing and avoids a silent zero.
 */
interface RawAnswer {
  type?: string;
  choice?: unknown;
  score?: unknown;
  noul?: unknown;
  value?: unknown;
  probability?: unknown;
  probabilities?: Record<string, number>;
  legend?: Record<string, string>;
  confidence?: unknown;
}

export class SystemOneDecider implements Decider {
  readonly name: string;

  #apiKey: string | undefined;
  #fetch: FetchLike;
  #baseUrl: string;
  #model: string | undefined;
  #path: string;
  #timeoutMs: number;

  constructor(config: SystemOneConfig, name?: string) {
    const preset = config.preset ? SYSTEM_ONE_PRESETS[config.preset] : undefined;

    this.name = name ?? (config.preset ? `system-one:${config.preset}` : "system-one");
    this.#apiKey = config.apiKey;
    this.#fetch = config.fetch;
    this.#baseUrl = (config.baseUrl ?? preset?.baseUrl ?? SYSTEM_ONE_PRESETS.jev.baseUrl).replace(
      /\/+$/,
      "",
    );
    this.#model = config.model ?? preset?.model;
    this.#path = config.path ?? DEFAULT_PATH;
    this.#timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async ask(
    state: unknown,
    questions: Record<string, Question>,
    signal?: AbortSignal,
  ): Promise<Record<string, Answer>> {
    const body: Record<string, unknown> = { state, questions };
    if (this.#model) body.model = this.#model;

    const raw = await this.#post(body, signal);
    const answers = (raw as { answers?: Record<string, RawAnswer> }).answers;
    if (!answers || typeof answers !== "object") {
      throw new DeciderError("response had no `answers` object", this.name, raw);
    }

    const out: Record<string, Answer> = {};
    for (const [key, question] of Object.entries(questions)) {
      const rawAnswer = answers[key];
      if (!rawAnswer) {
        throw new DeciderError(`missing answer for question "${key}"`, this.name, raw);
      }
      out[key] = normaliseAnswer(rawAnswer, question, this.name);
    }
    return out;
  }

  async choose<T extends string>(
    state: unknown,
    question: ChoiceQuestion<T>,
    signal?: AbortSignal,
  ): Promise<ChoiceAnswer<T>> {
    const { only } = await this.ask(state, { only: question }, signal);
    return only as ChoiceAnswer<T>;
  }

  async score(state: unknown, question: ScoreQuestion, signal?: AbortSignal): Promise<ScoreAnswer> {
    const { only } = await this.ask(state, { only: question }, signal);
    return only as ScoreAnswer;
  }

  async yesNo(state: unknown, question: NoulQuestion, signal?: AbortSignal): Promise<NoulAnswer> {
    const { only } = await this.ask(state, { only: question }, signal);
    return only as NoulAnswer;
  }

  async healthy(): Promise<boolean> {
    try {
      await this.yesNo({ probe: "ok" }, { type: "noul", instructions: "Is this a probe?" });
      return true;
    } catch {
      return false;
    }
  }

  async #post(body: unknown, signal?: AbortSignal): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });

    const headers: Record<string, string> = { "content-type": "application/json" };
    // A self-hosted server usually has no auth; sending an empty bearer token
    // would be worse than sending none.
    if (this.#apiKey) headers.authorization = `Bearer ${this.#apiKey}`;

    try {
      const response = await this.#fetch(`${this.#baseUrl}${this.#path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new DeciderError(
          `HTTP ${response.status} from ${this.name}: ${detail.slice(0, 200)}`,
          this.name,
        );
      }
      return await response.json();
    } catch (error) {
      if (error instanceof DeciderError) throw error;
      throw new DeciderError(`request failed: ${String(error)}`, this.name, error);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

function toUnit(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

/**
 * Converts a wire answer into our typed shape.
 *
 * The one piece of real arithmetic is the score: the server returns a position
 * on the rubric — `1.43` across three levels — which we divide by the top level
 * index to get 0..1. That makes scores comparable across questions with
 * different numbers of levels, which is what the weighted quality sum needs.
 */
export function normaliseAnswer(raw: RawAnswer, question: Question, decider: string): Answer {
  const confidence = toUnit(raw.confidence, 0.5);

  switch (question.type) {
    case "choice": {
      const keys = Object.keys(question.criteria);
      const probabilities = raw.probabilities ?? {};
      const reported = raw.choice ?? raw.value;
      let value = typeof reported === "string" ? reported : undefined;

      if (value === undefined || !keys.includes(value)) {
        // Either the field was absent or the model named an option that does
        // not exist. Fall back to argmax over the distribution we did get.
        value = keys.reduce(
          (best, key) => ((probabilities[key] ?? 0) > (probabilities[best] ?? 0) ? key : best),
          keys[0] ?? "",
        );
      }
      if (!value) {
        throw new DeciderError("choice question had no options", decider, raw);
      }
      return { type: "choice", value, probabilities, confidence };
    }

    case "score": {
      const levels = question.criteria;
      const top = Math.max(1, levels.length - 1);

      // A level name is accepted too — the LLM emulation returns one, because
      // models pick a named rubric level far more reliably than a float.
      if (typeof raw.score === "string" && levels.includes(raw.score)) {
        const index = levels.indexOf(raw.score);
        return { type: "score", value: index / top, level: raw.score, confidence };
      }
      if (typeof raw.value === "string" && levels.includes(raw.value)) {
        const index = levels.indexOf(raw.value);
        return { type: "score", value: index / top, level: raw.value, confidence };
      }

      const reported = raw.score ?? raw.value;
      const n = typeof reported === "number" ? reported : Number(reported);
      if (!Number.isFinite(n)) {
        throw new DeciderError("score answer was not numeric", decider, raw);
      }

      const unit = Math.min(1, Math.max(0, n / top));
      const level = levels[Math.round(unit * top)] ?? levels[levels.length - 1] ?? "unknown";
      return { type: "score", value: unit, level, confidence };
    }

    case "noul": {
      const probability = toUnit(raw.noul ?? raw.probability ?? raw.value, 0.5);
      return { type: "noul", probability, confidence };
    }
  }
}
