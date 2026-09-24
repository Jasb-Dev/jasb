/**
 * Automatic fallback across deciders.
 *
 * Order matters: put the fastest one first. When one fails we mark it cold for
 * a cooldown window rather than retrying it on every single query — a decider
 * that is down stays down for a few seconds, and paying its timeout on each
 * request would blow the latency budget for everyone.
 */

import type { Logger } from "../types.ts";
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

export interface AutoDeciderOptions {
  /** How long a failed decider is skipped before we try it again. Default 30s. */
  cooldownMs?: number;
  logger?: Logger;
  now?: () => number;
}

export class AutoDecider implements Decider {
  readonly name: string;

  #deciders: Decider[];
  #cooldownMs: number;
  #coldUntil = new Map<string, number>();
  #logger: Logger | undefined;
  #now: () => number;

  constructor(deciders: Decider[], options: AutoDeciderOptions = {}) {
    if (deciders.length === 0) {
      throw new Error("AutoDecider needs at least one decider");
    }
    this.#deciders = deciders;
    this.#cooldownMs = options.cooldownMs ?? 30_000;
    this.#logger = options.logger;
    this.#now = options.now ?? (() => Date.now());
    this.name = `auto(${deciders.map((d) => d.name).join(" → ")})`;
  }

  async ask(
    state: unknown,
    questions: Record<string, Question>,
    signal?: AbortSignal,
  ): Promise<Record<string, Answer>> {
    return this.#run((decider) => decider.ask(state, questions, signal));
  }

  async choose<T extends string>(
    state: unknown,
    question: ChoiceQuestion<T>,
    signal?: AbortSignal,
  ): Promise<ChoiceAnswer<T>> {
    return this.#run((decider) => decider.choose(state, question, signal));
  }

  async score(state: unknown, question: ScoreQuestion, signal?: AbortSignal): Promise<ScoreAnswer> {
    return this.#run((decider) => decider.score(state, question, signal));
  }

  async yesNo(state: unknown, question: NoulQuestion, signal?: AbortSignal): Promise<NoulAnswer> {
    return this.#run((decider) => decider.yesNo(state, question, signal));
  }

  async healthy(): Promise<boolean> {
    for (const decider of this.#deciders) {
      if (await (decider.healthy?.() ?? Promise.resolve(true))) return true;
    }
    return false;
  }

  async #run<T>(operation: (decider: Decider) => Promise<T>): Promise<T> {
    const now = this.#now();
    const warm = this.#deciders.filter((d) => (this.#coldUntil.get(d.name) ?? 0) <= now);
    // Everything is cold — the outage is total, so try them all anyway rather
    // than failing without a single attempt.
    const order = warm.length > 0 ? warm : this.#deciders;

    let lastError: unknown;
    for (const decider of order) {
      try {
        const result = await operation(decider);
        this.#coldUntil.delete(decider.name);
        return result;
      } catch (error) {
        lastError = error;
        this.#coldUntil.set(decider.name, this.#now() + this.#cooldownMs);
        this.#logger?.warn("decider failed, falling back", {
          decider: decider.name,
          error: String(error),
        });
      }
    }

    throw new DeciderError(
      `all deciders failed (${order.map((d) => d.name).join(", ")})`,
      this.name,
      lastError,
    );
  }
}
