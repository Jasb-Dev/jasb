/**
 * Test doubles.
 *
 * The engine takes every capability as a port, so a full end-to-end test needs
 * no network, no API keys and no clock — which is exactly the property that
 * makes the golden-set regression job cheap enough to run on every commit.
 */

import type {
  Answer,
  ChoiceQuestion,
  Decider,
  NoulQuestion,
  Question,
  ScoreQuestion,
} from "../src/decider/types.ts";
import type { Candidate, FetchLike, Lens } from "../src/types.ts";
import type { SearchRequest, SearchSource } from "../src/sources/types.ts";

/**
 * A decider that answers from a lookup table.
 *
 * `relevanceByDomain` lets a test say "rank example.org above example.com"
 * without stubbing the whole scoring chain.
 */
export class FakeDecider implements Decider {
  readonly name = "fake";
  calls: { state: unknown; questions: string[] }[] = [];

  #options: {
    intent?: string;
    lens?: string;
    relevanceByDomain?: Record<string, number>;
    spamByDomain?: Record<string, number>;
    reasonByDomain?: Record<string, string>;
    confidence?: number;
    fail?: boolean;
    sameIntent?: number;
  };

  constructor(
    options: {
      intent?: string;
      lens?: string;
      relevanceByDomain?: Record<string, number>;
      spamByDomain?: Record<string, number>;
      reasonByDomain?: Record<string, string>;
      confidence?: number;
      /** Throw on every call, to exercise the fallback paths. */
      fail?: boolean;
      /** Answer to the semantic-cache confirmation question. */
      sameIntent?: number;
    } = {},
  ) {
    this.#options = options;
  }

  async ask(state: unknown, questions: Record<string, Question>): Promise<Record<string, Answer>> {
    if (this.#options.fail) throw new Error("fake decider is down");
    this.calls.push({ state, questions: Object.keys(questions) });

    const domain =
      typeof state === "object" && state !== null && "page" in state
        ? ((state as { page: { domain: string } }).page.domain ?? "")
        : "";
    const confidence = this.#options.confidence ?? 0.9;
    const out: Record<string, Answer> = {};

    for (const [key, question] of Object.entries(questions)) {
      switch (question.type) {
        case "choice": {
          const keys = Object.keys(question.criteria);
          const preferred =
            key === "intent"
              ? this.#options.intent
              : key === "lens"
                ? this.#options.lens
                : this.#options.reasonByDomain?.[domain];
          const value = preferred && keys.includes(preferred) ? preferred : (keys[0] ?? "");
          out[key] = {
            type: "choice",
            value,
            probabilities: { [value]: 0.9 },
            confidence,
          };
          break;
        }
        case "score": {
          const unit = this.#options.relevanceByDomain?.[domain] ?? 0.75;
          const index = Math.round(unit * (question.criteria.length - 1));
          out[key] = {
            type: "score",
            value: unit,
            level: question.criteria[index] ?? "relevant",
            confidence,
          };
          break;
        }
        case "noul": {
          const probability =
            key === "spam"
              ? (this.#options.spamByDomain?.[domain] ?? 0.05)
              : (this.#options.sameIntent ?? 0.95);
          out[key] = { type: "noul", probability, confidence };
          break;
        }
      }
    }
    return out;
  }

  async choose<T extends string>(state: unknown, question: ChoiceQuestion<T>) {
    const { only } = await this.ask(state, { only: question });
    return only as never;
  }
  async score(state: unknown, question: ScoreQuestion) {
    const { only } = await this.ask(state, { only: question });
    return only as never;
  }
  async yesNo(state: unknown, question: NoulQuestion) {
    const { only } = await this.ask(state, { only: question });
    return only as never;
  }
}

/** A source that returns a fixed list, optionally after a delay or an error. */
export class FakeSource implements SearchSource {
  readonly lenses: readonly Lens[] | "*";
  readonly costPerThousand = 0;
  calls = 0;

  readonly name: string;
  #results: Partial<Candidate>[];
  #options: { delayMs?: number; fail?: boolean; lenses?: readonly Lens[] | "*" };

  constructor(
    name: string,
    results: Partial<Candidate>[],
    options: { delayMs?: number; fail?: boolean; lenses?: readonly Lens[] | "*" } = {},
  ) {
    this.name = name;
    this.#results = results;
    this.#options = options;
    this.lenses = options.lenses ?? "*";
  }

  async search(request: SearchRequest): Promise<Candidate[]> {
    this.calls += 1;
    if (this.#options.delayMs) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, this.#options.delayMs);
        request.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          },
          { once: true },
        );
      });
    }
    if (this.#options.fail) throw new Error(`${this.name} is down`);

    return this.#results.slice(0, request.limit).map((result, index) => ({
      url: result.url ?? `https://example${index}.com/`,
      title: result.title ?? `Result ${index}`,
      snippet: result.snippet ?? "",
      domain: result.domain ?? new URL(result.url ?? "https://example.com").hostname,
      sources: [this.name],
      rank: result.rank ?? index,
      ...(result.imageUrl ? { imageUrl: result.imageUrl } : {}),
    }));
  }
}

/** A `fetch` that answers from a route table. Unlisted URLs 404. */
export function fakeFetch(
  routes: Record<string, { status?: number; body?: unknown }> = {},
): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (input: string) => {
    calls.push(input);
    const route = routes[input] ?? routes["*"];
    const status = route?.status ?? (route ? 200 : 404);
    const body = route?.body ?? {};
    return {
      ok: status >= 200 && status < 300,
      status,
      url: input,
      headers: { get: () => null },
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
      json: async () => body,
    };
  }) as FetchLike & { calls: string[] };
  fn.calls = calls;
  return fn;
}

/** A clock the test drives by hand, so TTL behaviour is deterministic. */
export function fakeClock(start = 1_700_000_000_000) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}
