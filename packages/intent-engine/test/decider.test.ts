import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AutoDecider } from "../src/decider/auto.ts";
import { SystemOneDecider, normaliseAnswer } from "../src/decider/systemone.ts";
import { LlmDecider } from "../src/decider/llm.ts";
import type { Question } from "../src/decider/types.ts";
import type { FetchLike } from "../src/types.ts";
import { FakeDecider } from "./helpers.ts";

function jsonFetch(handler: (url: string, body: unknown) => unknown): FetchLike & {
  bodies: unknown[];
} {
  const bodies: unknown[] = [];
  const fn = (async (url: string, init?: { body?: string }) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    bodies.push(body);
    const result = handler(url, body);
    return {
      ok: true,
      status: 200,
      url,
      headers: { get: () => null },
      text: async () => JSON.stringify(result),
      json: async () => result,
    };
  }) as FetchLike & { bodies: unknown[] };
  fn.bodies = bodies;
  return fn;
}

describe("normaliseAnswer", () => {
  const scoreQuestion: Question = {
    type: "score",
    instructions: "how relevant",
    criteria: ["irrelevant", "tangential", "relevant", "exact"],
  };

  it("reads the canonical `score` field as a rubric position", () => {
    // The documented wire shape: a float from 0 to (levels - 1). With 4 levels
    // the top is 3, so 3 → 1.0.
    const answer = normaliseAnswer({ type: "score", score: 3, confidence: 0.8 }, scoreQuestion, "t");
    assert.equal(answer.type, "score");
    assert.equal(answer.type === "score" && answer.value, 1);
    assert.equal(answer.type === "score" && answer.level, "exact");
  });

  it("handles a fractional rubric position", () => {
    // The real API returns values like 1.43 — the probability-weighted mean of
    // the level indices, not a whole number.
    const answer = normaliseAnswer({ score: 1.5, confidence: 0.35 }, scoreQuestion, "t");
    assert.ok(answer.type === "score" && Math.abs(answer.value - 0.5) < 1e-9);
  });

  it("reads a bare 1 as level 1, not as a perfect score", () => {
    // This is the bug the documented format settles: `score` is always an index
    // position, so 1 of 4 levels is 1/3 — treating it as a normalised 1.0 would
    // promote a barely-relevant page to the top of the grid.
    const answer = normaliseAnswer({ score: 1, confidence: 0.8 }, scoreQuestion, "t");
    assert.ok(answer.type === "score" && Math.abs(answer.value - 1 / 3) < 1e-9);
    assert.equal(answer.type === "score" && answer.level, "tangential");
  });

  it("accepts a level name, which is what the LLM emulation returns", () => {
    const answer = normaliseAnswer({ score: "relevant", confidence: 0.8 }, scoreQuestion, "t");
    assert.ok(answer.type === "score" && Math.abs(answer.value - 2 / 3) < 1e-9);
    assert.equal(answer.type === "score" && answer.level, "relevant");
  });

  it("recovers a choice from probabilities when `choice` is missing", () => {
    const question: Question = {
      type: "choice",
      instructions: "pick",
      criteria: { a: "A", b: "B", c: "C" },
    };
    const answer = normaliseAnswer(
      { probabilities: { a: 0.1, b: 0.7, c: 0.2 }, confidence: 0.7 },
      question,
      "t",
    );
    assert.equal(answer.type === "choice" && answer.value, "b");
  });

  it("rejects a choice value that is not an option", () => {
    const question: Question = {
      type: "choice",
      instructions: "pick",
      criteria: { a: "A", b: "B" },
    };
    const answer = normaliseAnswer(
      { choice: "hallucinated", probabilities: { a: 0.2, b: 0.8 }, confidence: 0.6 },
      question,
      "t",
    );
    assert.equal(answer.type === "choice" && answer.value, "b");
  });

  it("clamps out-of-range confidence rather than trusting it", () => {
    const question: Question = { type: "noul", instructions: "true?" };
    const answer = normaliseAnswer({ noul: 1.7, confidence: -3 }, question, "t");
    assert.equal(answer.type === "noul" && answer.probability, 1);
    assert.equal(answer.confidence, 0);
  });
});

describe("SystemOneDecider", () => {
  it("sends state + questions and normalises the documented reply shape", async () => {
    const fetch = jsonFetch(() => ({
      model: "kev-9b",
      answers: {
        intent: {
          type: "choice",
          choice: "code",
          probabilities: { code: 0.9, news: 0.1 },
          confidence: 0.91,
        },
        spam: { type: "noul", noul: 0.03, confidence: 0.88 },
      },
    }));
    const decider = new SystemOneDecider({ apiKey: "k", fetch });

    const answers = await decider.ask(
      { query: "x" },
      {
        intent: { type: "choice", instructions: "?", criteria: { code: "c", news: "n" } },
        spam: { type: "noul", instructions: "spam?" },
      },
    );

    assert.equal(answers.intent?.type === "choice" && answers.intent.value, "code");
    assert.equal(answers.spam?.type === "noul" && answers.spam.probability, 0.03);

    const body = fetch.bodies[0] as { state: unknown; questions: unknown };
    assert.deepEqual(body.state, { query: "x" });
    assert.ok(body.questions);
  });

  it("posts to the documented /v1/systemone path", async () => {
    const urls: string[] = [];
    const fetch = jsonFetch((url) => {
      urls.push(url);
      return { answers: { only: { type: "noul", noul: 0.5, confidence: 0.5 } } };
    });
    const decider = new SystemOneDecider({ apiKey: "k", fetch });
    await decider.yesNo({}, { type: "noul", instructions: "?" });

    assert.equal(urls[0], "https://api.typesafe.ai/v1/systemone");
  });

  it("points at an open self-hosted model when given a preset", async () => {
    const urls: string[] = [];
    const fetch = jsonFetch((url) => {
      urls.push(url);
      return { answers: { only: { type: "noul", noul: 0.5, confidence: 0.5 } } };
    });
    const decider = new SystemOneDecider({ preset: "kev", fetch });
    await decider.yesNo({}, { type: "noul", instructions: "?" });

    assert.ok(urls[0]?.endsWith("/v1/systemone"), urls[0]);
    assert.equal((fetch.bodies[0] as { model: string }).model, "kev-9b");
    assert.equal(decider.name, "system-one:kev");
  });

  it("omits the authorisation header when no key is configured", async () => {
    // Self-hosted servers usually have no auth; an empty bearer token is worse
    // than none at all.
    const headers: (Record<string, string> | undefined)[] = [];
    const fn = (async (_url: string, init?: { headers?: Record<string, string> }) => {
      headers.push(init?.headers);
      const body = { answers: { only: { type: "noul", noul: 0.5, confidence: 0.5 } } };
      return {
        ok: true,
        status: 200,
        url: _url,
        headers: { get: () => null },
        text: async () => JSON.stringify(body),
        json: async () => body,
      };
    }) as FetchLike;

    const decider = new SystemOneDecider({ preset: "von", fetch: fn });
    await decider.yesNo({}, { type: "noul", instructions: "?" });
    assert.equal(headers[0]?.authorization, undefined);
  });

  it("fails loudly when an answer is missing rather than inventing one", async () => {
    const fetch = jsonFetch(() => ({ answers: {} }));
    const decider = new SystemOneDecider({ apiKey: "k", fetch });

    await assert.rejects(
      () => decider.yesNo({}, { type: "noul", instructions: "?" }),
      /missing answer/,
    );
  });
});

describe("LlmDecider", () => {
  it("constrains Anthropic output with a JSON schema built from the questions", async () => {
    const fetch = jsonFetch(() => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            answers: { only: { score: "relevant", confidence: 0.8 } },
          }),
        },
      ],
    }));
    const decider = new LlmDecider({ provider: "anthropic", apiKey: "k", fetch });

    const answer = await decider.score(
      { page: "x" },
      { type: "score", instructions: "?", criteria: ["bad", "ok", "relevant"] },
    );
    assert.equal(answer.level, "relevant");
    assert.equal(answer.value, 1);

    const body = fetch.bodies[0] as {
      model: string;
      output_config: { format: { type: string; schema: Record<string, unknown> } };
    };
    assert.equal(body.model, "claude-opus-5");
    assert.equal(body.output_config.format.type, "json_schema");
    assert.equal(body.output_config.format.schema.additionalProperties, false);
  });

  it("tolerates a model that wraps its JSON in a code fence", async () => {
    const fetch = jsonFetch(() => ({
      choices: [
        {
          message: {
            content:
              "```json\n" +
              JSON.stringify({ answers: { only: { noul: 0.9, confidence: 0.7 } } }) +
              "\n```",
          },
        },
      ],
    }));
    const decider = new LlmDecider({ provider: "openai", apiKey: "k", fetch });

    const answer = await decider.yesNo({}, { type: "noul", instructions: "?" });
    assert.equal(answer.probability, 0.9);
  });

  it("strips additionalProperties for Gemini, which rejects the key", async () => {
    const fetch = jsonFetch(() => ({
      candidates: [
        {
          content: {
            parts: [{ text: JSON.stringify({ answers: { only: { noul: 0.5, confidence: 0.5 } } }) }],
          },
        },
      ],
    }));
    const decider = new LlmDecider({ provider: "gemini", apiKey: "k", fetch });
    await decider.yesNo({}, { type: "noul", instructions: "?" });

    const body = fetch.bodies[0] as {
      generationConfig: { responseSchema: Record<string, unknown> };
    };
    const schema = JSON.stringify(body.generationConfig.responseSchema);
    assert.ok(!schema.includes("additionalProperties"), schema);
  });
});

describe("AutoDecider", () => {
  it("prefers the first decider while it is healthy", async () => {
    const primary = new FakeDecider({ intent: "code" });
    const backup = new FakeDecider({ intent: "news" });
    const auto = new AutoDecider([primary, backup]);

    const answers = await auto.ask({}, {
      intent: { type: "choice", instructions: "?", criteria: { code: "c", news: "n" } },
    });
    assert.equal(answers.intent?.type === "choice" && answers.intent.value, "code");
    assert.equal(backup.calls.length, 0);
  });

  it("falls through to the backup when the primary is down", async () => {
    const primary = new FakeDecider({ fail: true });
    const backup = new FakeDecider({ intent: "news" });
    const auto = new AutoDecider([primary, backup]);

    const answers = await auto.ask({}, {
      intent: { type: "choice", instructions: "?", criteria: { code: "c", news: "n" } },
    });
    assert.equal(answers.intent?.type === "choice" && answers.intent.value, "news");
  });

  it("stops retrying a failed decider until its cooldown expires", async () => {
    let time = 0;
    const primary = new FakeDecider({ fail: true });
    const backup = new FakeDecider({ intent: "news" });
    const auto = new AutoDecider([primary, backup], {
      cooldownMs: 1_000,
      now: () => time,
    });

    const batch = {
      intent: {
        type: "choice" as const,
        instructions: "?",
        criteria: { code: "c", news: "n" },
      },
    };

    await auto.ask({}, batch);
    await auto.ask({}, batch);
    await auto.ask({}, batch);
    // The primary throws before recording a call, so we assert via the backup:
    // three queries, three backup calls, and no wasted primary timeout.
    assert.equal(backup.calls.length, 3);

    time = 2_000; // cooldown elapsed — the primary is eligible again
    await auto.ask({}, batch);
    assert.equal(backup.calls.length, 4, "primary retried and failed, backup answered");
  });

  it("reports a total outage rather than hanging", async () => {
    const auto = new AutoDecider([new FakeDecider({ fail: true })]);
    await assert.rejects(
      () => auto.yesNo({}, { type: "noul", instructions: "?" }),
      /all deciders failed/,
    );
  });
});
