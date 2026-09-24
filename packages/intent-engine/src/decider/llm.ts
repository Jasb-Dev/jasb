/**
 * The LLM fallback.
 *
 * Emulates Jev's three primitives with a JSON-constrained chat model. Slower
 * and pricier per query than a System One model, but it is the path that works
 * with a key the user already owns — which is the whole BYOK story — and it is
 * what the auto-fallback wrapper drops to when the hosted decider is down.
 *
 * Every provider here is reached through the same schema-constrained shape, so
 * the answers normalise through `normaliseAnswer` exactly like Jev's.
 */

import type { FetchLike } from "../types.ts";
import { normaliseAnswer } from "./systemone.ts";
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

export type LlmProvider = "anthropic" | "openai" | "openrouter" | "gemini" | "ollama";

export interface LlmConfig {
  provider: LlmProvider;
  apiKey: string;
  fetch: FetchLike;
  /** Defaults per provider; override for self-hosted or proxied endpoints. */
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  /**
   * Set when the request originates from a browser and the provider requires an
   * explicit opt-in header (Anthropic does).
   */
  allowBrowser?: boolean;
}

const DEFAULTS: Record<LlmProvider, { baseUrl: string; model: string }> = {
  // Opus 5 is the default. `claude-haiku-4-5` is the cost-optimised swap for
  // this workload — see README → "Choosing a rerank model".
  anthropic: { baseUrl: "https://api.anthropic.com", model: "claude-opus-5" },
  openai: { baseUrl: "https://api.openai.com", model: "gpt-4.1-mini" },
  openrouter: { baseUrl: "https://openrouter.ai/api", model: "anthropic/claude-haiku-4.5" },
  gemini: { baseUrl: "https://generativelanguage.googleapis.com", model: "gemini-2.0-flash" },
  ollama: { baseUrl: "http://127.0.0.1:11434", model: "llama3.2" },
};

const SYSTEM_PROMPT = [
  "You are a decision engine, not a writer.",
  "You are given a STATE and a set of typed QUESTIONS about it.",
  "Answer every question. Return JSON matching the schema exactly.",
  "Never invent fields. Never add prose. `confidence` is your calibrated certainty from 0 to 1 —",
  "use low values when the state genuinely does not settle the question.",
].join(" ");

const DEFAULT_TIMEOUT_MS = 12_000;

export class LlmDecider implements Decider {
  readonly name: string;

  #config: LlmConfig;
  #baseUrl: string;
  #model: string;
  #timeoutMs: number;

  constructor(config: LlmConfig) {
    this.#config = config;
    const defaults = DEFAULTS[config.provider];
    this.name = `llm:${config.provider}`;
    this.#baseUrl = (config.baseUrl ?? defaults.baseUrl).replace(/\/+$/, "");
    this.#model = config.model ?? defaults.model;
    this.#timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async ask(
    state: unknown,
    questions: Record<string, Question>,
    signal?: AbortSignal,
  ): Promise<Record<string, Answer>> {
    const schema = buildSchema(questions);
    const userPrompt = [
      "STATE:",
      JSON.stringify(state, null, 2),
      "",
      "QUESTIONS:",
      JSON.stringify(questions, null, 2),
    ].join("\n");

    const text = await this.#complete(userPrompt, schema, signal);

    let parsed: { answers?: Record<string, unknown> };
    try {
      parsed = JSON.parse(stripCodeFence(text)) as never;
    } catch (error) {
      throw new DeciderError(
        `model returned non-JSON: ${text.slice(0, 200)}`,
        this.name,
        error,
      );
    }

    const out: Record<string, Answer> = {};
    for (const [key, question] of Object.entries(questions)) {
      const answer = parsed.answers?.[key];
      if (!answer || typeof answer !== "object") {
        throw new DeciderError(`missing answer for question "${key}"`, this.name, parsed);
      }
      out[key] = normaliseAnswer(answer as never, question, this.name);
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

  async #complete(
    userPrompt: string,
    schema: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      switch (this.#config.provider) {
        case "anthropic":
          return await this.#anthropic(userPrompt, schema, controller.signal);
        case "gemini":
          return await this.#gemini(userPrompt, schema, controller.signal);
        case "openai":
        case "openrouter":
        case "ollama":
          return await this.#openAiCompatible(userPrompt, schema, controller.signal);
        default: {
          // Unreachable while `LlmProvider` and this switch agree; the guard is
          // here so adding a provider to the union fails the build instead of
          // silently falling through at runtime.
          const exhaustive: never = this.#config.provider;
          throw new DeciderError(`unsupported provider: ${String(exhaustive)}`, this.name);
        }
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async #anthropic(
    userPrompt: string,
    schema: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-api-key": this.#config.apiKey,
      "anthropic-version": "2023-06-01",
    };
    if (this.#config.allowBrowser) {
      headers["anthropic-dangerous-direct-browser-access"] = "true";
    }

    const body = {
      model: this.#model,
      max_tokens: 4_000,
      system: SYSTEM_PROMPT,
      // Ranking is a fast, bounded judgement — thinking would only add latency,
      // and `output_config.format` makes stray reasoning text impossible anyway.
      thinking: { type: "disabled" },
      output_config: {
        effort: "low",
        format: { type: "json_schema", schema },
      },
      messages: [{ role: "user", content: userPrompt }],
    };

    const json = await this.#post(`${this.#baseUrl}/v1/messages`, headers, body, signal);
    const content = (json as { content?: { type: string; text?: string }[] }).content ?? [];
    const text = content.find((block) => block.type === "text")?.text;
    if (!text) {
      const stop = (json as { stop_reason?: string }).stop_reason;
      throw new DeciderError(`no text block in response (stop_reason=${stop})`, this.name, json);
    }
    return text;
  }

  async #openAiCompatible(
    userPrompt: string,
    schema: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<string> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.#config.apiKey) headers.authorization = `Bearer ${this.#config.apiKey}`;
    if (this.#config.provider === "openrouter") {
      headers["x-title"] = "Jasb";
    }

    const body = {
      model: this.#model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "decisions", strict: true, schema },
      },
    };

    const json = await this.#post(
      `${this.#baseUrl}/v1/chat/completions`,
      headers,
      body,
      signal,
    );
    const text = (json as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message
      ?.content;
    if (!text) throw new DeciderError("no message content in response", this.name, json);
    return text;
  }

  async #gemini(
    userPrompt: string,
    schema: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<string> {
    const url = `${this.#baseUrl}/v1beta/models/${this.#model}:generateContent?key=${encodeURIComponent(this.#config.apiKey)}`;
    const body = {
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: toGeminiSchema(schema),
      },
    };

    const json = await this.#post(url, { "content-type": "application/json" }, body, signal);
    const text = (json as { candidates?: { content?: { parts?: { text?: string }[] } }[] })
      .candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new DeciderError("no candidate text in response", this.name, json);
    return text;
  }

  async #post(
    url: string,
    headers: Record<string, string>,
    body: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await this.#config.fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      throw new DeciderError(`request failed: ${String(error)}`, this.name, error);
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new DeciderError(
        `HTTP ${response.status}: ${detail.slice(0, 300)}`,
        this.name,
      );
    }
    return response.json();
  }
}

// ---------------------------------------------------------------------------
// Schema construction
// ---------------------------------------------------------------------------

/**
 * Builds one JSON schema covering every question in the batch.
 *
 * Score questions are expressed as an enum over level names rather than a
 * number: models place themselves on a named rubric far more reliably than they
 * pick a float, and `normaliseAnswer` converts the level back to 0..1.
 */
function buildSchema(questions: Record<string, Question>): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, question] of Object.entries(questions)) {
    required.push(key);
    switch (question.type) {
      // Field names match the System One wire format exactly, so an answer from
      // a chat model and an answer from a decision model normalise identically.
      case "choice":
        properties[key] = objectSchema(
          {
            choice: { type: "string", enum: Object.keys(question.criteria) },
            confidence: { type: "number" },
          },
          ["choice", "confidence"],
        );
        break;
      case "score":
        // The rubric level by name, not a float: models place themselves on a
        // named scale far more reliably than they pick a number.
        properties[key] = objectSchema(
          {
            score: { type: "string", enum: question.criteria },
            confidence: { type: "number" },
          },
          ["score", "confidence"],
        );
        break;
      case "noul":
        properties[key] = objectSchema(
          {
            noul: { type: "number" },
            confidence: { type: "number" },
          },
          ["noul", "confidence"],
        );
        break;
    }
  }

  return objectSchema({ answers: objectSchema(properties, required) }, ["answers"]);
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

/** Gemini's schema dialect has no `additionalProperties`; it rejects the key outright. */
function toGeminiSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const { additionalProperties: _drop, ...rest } = schema;
  const out: Record<string, unknown> = { ...rest };
  if (rest.properties && typeof rest.properties === "object") {
    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest.properties as Record<string, unknown>)) {
      properties[key] =
        value && typeof value === "object"
          ? toGeminiSchema(value as Record<string, unknown>)
          : value;
    }
    out.properties = properties;
  }
  return out;
}

/** Some models wrap JSON in a fence even under a schema constraint. */
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  return trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
}
