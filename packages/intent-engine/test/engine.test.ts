import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MemoryCacheStore } from "../src/cache/index.ts";
import { IntentEngine } from "../src/engine.ts";
import { NavigationIndex } from "../src/navigation/index.ts";
import type { PreferenceStore } from "../src/types.ts";
import { fakeClock, fakeFetch, FakeDecider, FakeSource } from "./helpers.ts";

function buildEngine(overrides: Partial<ConstructorParameters<typeof IntentEngine>[0]> = {}) {
  const decider = new FakeDecider({ intent: "research", lens: "general" });
  const source = new FakeSource("brave", [
    { url: "https://docs.python.org/3/library/json.html", title: "json — JSON encoder" },
    { url: "https://stackoverflow.com/questions/1", title: "Parsing JSON in Python" },
    { url: "https://ehow.com/how-to-json", title: "How To JSON" },
  ]);

  const engine = new IntentEngine({
    decider,
    sources: [source],
    fetch: fakeFetch({ "*": { status: 200 } }),
    navigation: false,
    verifyNavigation: false,
    ...overrides,
  });
  return { engine, decider, source };
}

describe("IntentEngine — early exits", () => {
  it("navigates straight to a URL without touching a source", async () => {
    const { engine, source } = buildEngine();
    const result = await engine.resolve("https://example.com/x");

    assert.equal(result.kind, "navigate");
    assert.equal(result.kind === "navigate" && result.via, "url");
    assert.equal(source.calls, 0, "a URL must never cost a search call");
  });

  it("navigates on a bang without touching a source", async () => {
    const { engine, source } = buildEngine();
    const result = await engine.resolve("!gh rust");

    assert.equal(result.kind, "navigate");
    assert.equal(result.kind === "navigate" && result.via, "bang");
    assert.equal(source.calls, 0);
  });

  it("uses the navigation index before paying for search", async () => {
    const { engine, source } = buildEngine({
      navigation: new NavigationIndex(),
      verifyNavigation: false,
    });
    const result = await engine.resolve("figma sign in");

    assert.equal(result.kind, "navigate");
    assert.equal(result.kind === "navigate" && result.via, "navigation-index");
    assert.equal(result.kind === "navigate" && result.url, "https://figma.com");
    assert.equal(source.calls, 0);
  });

  it("falls through to search when the navigation destination is dead", async () => {
    const { engine, source } = buildEngine({
      navigation: new NavigationIndex(),
      verifyNavigation: true,
      // Every HEAD 404s, so the guess must be rejected.
      fetch: fakeFetch({}),
    });
    const result = await engine.resolve("figma sign in");

    assert.equal(result.kind, "cards");
    assert.equal(source.calls, 1);
  });

  it("does not navigate for a query that merely mentions a brand", async () => {
    const { engine } = buildEngine({ navigation: new NavigationIndex() });
    const result = await engine.resolve("is figma better than sketch for wireframes");
    assert.equal(result.kind, "cards");
  });
});

describe("IntentEngine — cards", () => {
  it("returns ranked cards with fixed reason labels", async () => {
    const { engine } = buildEngine();
    const result = await engine.resolve("parse json in python");

    assert.equal(result.kind, "cards");
    if (result.kind !== "cards") return;

    assert.ok(result.cards.length > 0);
    for (const card of result.cards) {
      assert.ok(card.reason.length > 0, "every card needs a reason label");
      assert.ok(card.score >= 0 && card.score <= 1);
      assert.ok(card.url.startsWith("https://"));
    }
    // Sorted by score, descending.
    const scores = result.cards.map((card) => card.score);
    assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
  });

  it("ranks a clean documentation domain above a content farm", async () => {
    const decider = new FakeDecider({
      intent: "code",
      lens: "programming",
      relevanceByDomain: {
        "docs.python.org": 0.9,
        "ehow.com": 0.9, // same relevance — only the quality signals differ
      },
      spamByDomain: { "docs.python.org": 0.02, "ehow.com": 0.9 },
    });
    const { engine } = buildEngine({ decider });

    const result = await engine.resolve("parse json in python");
    assert.equal(result.kind, "cards");
    if (result.kind !== "cards") return;

    const domains = result.cards.map((card) => card.domain);
    assert.ok(
      domains.indexOf("docs.python.org") < domains.indexOf("ehow.com"),
      `expected docs above the farm, got ${domains.join(", ")}`,
    );
  });

  it("shows fewer cards instead of filler when the decider is unsure", async () => {
    const decider = new FakeDecider({ confidence: 0.2 });
    const { engine } = buildEngine({ decider });

    const result = await engine.resolve("something extremely ambiguous");
    assert.equal(result.kind, "cards");
    if (result.kind !== "cards") return;

    assert.equal(result.lowConfidence, true);
    assert.ok(result.cards.length <= 3, `expected a short grid, got ${result.cards.length}`);
  });

  it("survives a source outage as long as one source answers", async () => {
    const good = new FakeSource("brave", [{ url: "https://example.org/a" }]);
    const bad = new FakeSource("serper", [], { fail: true });
    const { engine } = buildEngine({ sources: [bad, good] });

    const result = await engine.resolve("anything");
    assert.equal(result.kind, "cards");
    assert.ok(result.kind === "cards" && result.cards.length === 1);
  });

  it("does not let a slow source blow the latency budget", async () => {
    const fast = new FakeSource("brave", [{ url: "https://fast.example/a" }]);
    const slow = new FakeSource("slow", [{ url: "https://slow.example/a" }], { delayMs: 5_000 });
    const { engine } = buildEngine({ sources: [fast, slow], sourceDeadlineMs: 50 });

    const started = Date.now();
    const result = await engine.resolve("anything");
    const elapsed = Date.now() - started;

    assert.ok(elapsed < 1_000, `fan-out took ${elapsed}ms; the deadline did not fire`);
    assert.equal(result.kind, "cards");
    assert.deepEqual(
      result.kind === "cards" ? result.cards.map((c) => c.domain) : [],
      ["fast.example"],
    );
  });

  it("cuts stragglers short once a source has delivered, well inside the hard deadline", async () => {
    // The real-world shape: one healthy index plus one that hangs. Waiting the
    // full ceiling for the hung one would put every query over the latency
    // budget even though usable results arrived immediately.
    const fast = new FakeSource("brave", [{ url: "https://fast.example/a" }], { delayMs: 20 });
    const hung = new FakeSource("hung", [{ url: "https://hung.example/a" }], { delayMs: 30_000 });
    const { engine } = buildEngine({
      sources: [fast, hung],
      sourceDeadlineMs: 5_000,
      sourceGraceMs: 60,
    });

    const started = Date.now();
    const result = await engine.resolve("anything");
    const elapsed = Date.now() - started;

    assert.ok(
      elapsed < 600,
      `waited ${elapsed}ms — the grace window should have cut the hung source`,
    );
    assert.deepEqual(
      result.kind === "cards" ? result.cards.map((c) => c.domain) : [],
      ["fast.example"],
    );
  });

  it("waits for a real source rather than being cut short by an empty one", async () => {
    const empty = new FakeSource("empty", []);
    const real = new FakeSource("brave", [{ url: "https://real.example/a" }], { delayMs: 120 });
    const { engine } = buildEngine({
      sources: [empty, real],
      sourceDeadlineMs: 2_000,
      sourceGraceMs: 30,
    });

    const result = await engine.resolve("anything");
    assert.deepEqual(
      result.kind === "cards" ? result.cards.map((c) => c.domain) : [],
      ["real.example"],
      "an instantly-empty source must not start the grace clock",
    );
  });

  it("still returns cards when the decider is completely down", async () => {
    const { engine } = buildEngine({ decider: new FakeDecider({ fail: true }) });

    const result = await engine.resolve("how to make sourdough");
    assert.equal(result.kind, "cards");
    if (result.kind !== "cards") return;

    // Keyword heuristic took over.
    assert.equal(result.intent, "recipe");
    assert.ok(result.cards.length > 0, "an outage must degrade, not fail");
    assert.ok(result.cards.every((card) => card.reason.length > 0));
  });
});

describe("IntentEngine — cache", () => {
  it("serves a repeat query from cache without calling a source again", async () => {
    const cache = new MemoryCacheStore();
    const { engine, source } = buildEngine({ cache });

    const first = await engine.resolve("parse json in python");
    const second = await engine.resolve("parse json in python");

    assert.equal(first.kind === "cards" && first.cached, false);
    assert.equal(second.kind === "cards" && second.cached, true);
    assert.equal(source.calls, 1, "the second query must not hit the network");
  });

  it("treats a differently-typed but equivalent query as the same key", async () => {
    const cache = new MemoryCacheStore();
    const { engine, source } = buildEngine({ cache });

    await engine.resolve("Parse JSON in Python");
    const second = await engine.resolve("  parse   json in python!! ");

    assert.equal(second.kind === "cards" && second.cached, true);
    assert.equal(source.calls, 1);
  });

  it("re-runs the pipeline once the TTL expires", async () => {
    const clock = fakeClock();
    const cache = new MemoryCacheStore({ now: clock.now });
    // News has the shortest TTL — one hour — so it is the cheapest to exercise.
    const decider = new FakeDecider({ intent: "news", lens: "news" });
    const { engine, source } = buildEngine({ cache, clock, decider });

    await engine.resolve("breaking news today");
    clock.advance(2 * 60 * 60 * 1000); // news TTL is one hour
    const second = await engine.resolve("breaking news today");

    assert.equal(second.kind === "cards" && second.cached, false);
    assert.equal(source.calls, 2);
  });

  it("bypasses the cache on an explicit refresh", async () => {
    const cache = new MemoryCacheStore();
    const { engine, source } = buildEngine({ cache });

    await engine.resolve("parse json in python");
    await engine.resolve("parse json in python", { refresh: true });

    assert.equal(source.calls, 2);
  });
});

describe("IntentEngine — local preferences", () => {
  function preferenceStore(blocked: string[], pinned: string[]): PreferenceStore {
    return {
      blockedDomains: async () => blocked,
      pinnedDomains: async () => pinned,
      block: async () => {},
      unblock: async () => {},
      pin: async () => {},
      unpin: async () => {},
    };
  }

  it("never shows a blocked domain", async () => {
    const { engine } = buildEngine({
      preferences: preferenceStore(["ehow.com"], []),
    });

    const result = await engine.resolve("parse json in python");
    assert.equal(result.kind, "cards");
    assert.ok(
      result.kind === "cards" && result.cards.every((card) => card.domain !== "ehow.com"),
    );
  });

  it("blocks subdomains of a blocked domain", async () => {
    const source = new FakeSource("brave", [
      { url: "https://tracker.example.com/a" },
      { url: "https://clean.org/b" },
    ]);
    const { engine } = buildEngine({
      sources: [source],
      preferences: preferenceStore(["example.com"], []),
    });

    const result = await engine.resolve("anything");
    assert.deepEqual(
      result.kind === "cards" ? result.cards.map((c) => c.domain) : [],
      ["clean.org"],
    );
  });

  it("floats a pinned domain to the top", async () => {
    const decider = new FakeDecider({
      relevanceByDomain: { "ehow.com": 0.1, "docs.python.org": 0.95 },
    });
    const { engine } = buildEngine({
      decider,
      preferences: preferenceStore([], ["ehow.com"]),
    });

    const result = await engine.resolve("parse json in python");
    assert.equal(result.kind, "cards");
    if (result.kind !== "cards") return;

    assert.equal(result.cards[0]?.domain, "ehow.com");
    assert.equal(result.cards[0]?.pinned, true);
  });

  it("re-applies preferences to a cached result", async () => {
    const cache = new MemoryCacheStore();
    // Warm the cache with no preferences at all.
    const warm = buildEngine({ cache });
    await warm.engine.resolve("parse json in python");

    // A second device shares the cache but blocks a domain locally.
    const { engine } = buildEngine({
      cache,
      preferences: preferenceStore(["ehow.com"], []),
    });
    const result = await engine.resolve("parse json in python");

    assert.equal(result.kind === "cards" && result.cached, true);
    assert.ok(
      result.kind === "cards" && result.cards.every((card) => card.domain !== "ehow.com"),
      "the shared cache must stay anonymous; personalisation happens on read",
    );
  });
});
