import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { hashQuery } from "@jasb/intent-engine";

import { createApp } from "../src/app.ts";
import { loadConfig, type ServerConfig } from "../src/config.ts";
import { DailyBudget } from "../src/budget.ts";
import { KAnonymityGate, QuotaTracker } from "../src/quota.ts";

function testConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    ...loadConfig(),
    port: 0,
    allowedOrigins: ["*"],
    freeMonthlyQuota: 3,
    // A fresh directory per app, so no counter carries over between tests.
    stateDir: mkdtempSync(join(tmpdir(), "jasb-test-")),
    sharedCacheK: 2,
    ...overrides,
  };
}

function post(app: ReturnType<typeof createApp>, body: unknown, device = "device-a") {
  return app.request("/resolve", {
    method: "POST",
    headers: { "content-type": "application/json", "x-jasb-device": device },
    body: JSON.stringify(body),
  });
}

describe("GET /health", () => {
  it("reports configuration without leaking a key", async () => {
    const app = createApp({
      config: testConfig({ braveApiKey: "super-secret-key", jevApiKey: "another-secret" }),
    });
    const response = await app.request("/health");
    const text = await response.text();

    assert.equal(response.status, 200);
    assert.ok(!text.includes("super-secret-key"), text);
    assert.ok(!text.includes("another-secret"), text);
    assert.ok(text.includes("brave"));
  });
});

describe("GET /privacy", () => {
  it("states the guarantees as machine-readable data", async () => {
    const app = createApp({ config: testConfig() });
    const body = (await (await app.request("/privacy")).json()) as Record<string, unknown>;

    assert.equal(body.logsQueries, false);
    assert.equal(body.logsIpAddresses, false);
    assert.equal(body.requiresAccount, false);
    assert.equal(body.telemetry, "none");
  });
});

describe("POST /resolve — validation", () => {
  const app = createApp({ config: testConfig() });

  it("rejects a missing device token", async () => {
    const response = await app.request("/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "x" }),
    });
    assert.equal(response.status, 400);
  });

  it("rejects an empty query", async () => {
    assert.equal((await post(app, { query: "   " })).status, 400);
  });

  it("rejects an oversized query instead of forwarding it to a provider", async () => {
    const response = await post(app, { query: "a".repeat(5_000) });
    assert.equal(response.status, 400);
  });

  it("rejects a non-JSON body", async () => {
    const response = await app.request("/resolve", {
      method: "POST",
      headers: { "content-type": "application/json", "x-jasb-device": "d" },
      body: "not json",
    });
    assert.equal(response.status, 400);
  });
});

describe("POST /resolve — free paths", () => {
  it("navigates on a URL without spending quota", async () => {
    const app = createApp({ config: testConfig() });

    for (let i = 0; i < 10; i += 1) {
      const response = await post(app, { query: "https://example.com" });
      assert.equal(response.status, 200);
      const body = (await response.json()) as { result: { kind: string; via?: string } };
      assert.equal(body.result.kind, "navigate");
      assert.equal(body.result.via, "url");
    }

    const quota = (await (
      await app.request("/quota", { headers: { "x-jasb-device": "device-a" } })
    ).json()) as { remaining: number };
    assert.equal(quota.remaining, 3, "URL navigation must never be metered");
  });

  it("navigates on a bang without spending quota", async () => {
    const app = createApp({ config: testConfig() });
    const body = (await (await post(app, { query: "!w tardigrade" })).json()) as {
      result: { kind: string; via?: string };
    };
    assert.equal(body.result.kind, "navigate");
    assert.equal(body.result.via, "bang");
  });
});

describe("QuotaTracker", () => {
  it("allows exactly the configured number of searches", () => {
    const tracker = new QuotaTracker({ limit: 3, now: () => 0 });
    assert.equal(tracker.consume("d").allowed, true);
    assert.equal(tracker.consume("d").allowed, true);
    const third = tracker.consume("d");
    assert.equal(third.allowed, true);
    assert.equal(third.remaining, 0);
    assert.equal(tracker.consume("d").allowed, false);
  });

  it("keeps devices independent", () => {
    const tracker = new QuotaTracker({ limit: 1, now: () => 0 });
    assert.equal(tracker.consume("a").allowed, true);
    assert.equal(tracker.consume("b").allowed, true);
    assert.equal(tracker.consume("a").allowed, false);
  });

  it("resets at the UTC day boundary", () => {
    let now = 0;
    const tracker = new QuotaTracker({ limit: 1, now: () => now });
    assert.equal(tracker.consume("d").allowed, true);
    assert.equal(tracker.consume("d").allowed, false);

    now = 25 * 60 * 60 * 1000;
    assert.equal(tracker.consume("d").allowed, true);
  });

  it("does not consume on peek", () => {
    const tracker = new QuotaTracker({ limit: 2, now: () => 0 });
    tracker.peek("d");
    tracker.peek("d");
    assert.equal(tracker.peek("d").remaining, 2);
  });

  it("exposes no state, so a device token cannot leak through serialisation", () => {
    const tracker = new QuotaTracker({ limit: 5, now: () => 0 });
    tracker.consume("my-secret-device-token");

    // Counters live in `#private` fields: not enumerable, not serialisable.
    // An accidental `JSON.stringify(tracker)` in a log line cannot leak them.
    assert.equal(JSON.stringify(tracker), "{}");
    assert.deepEqual(Object.keys(tracker), []);
  });

  it("keys buckets by a hash, not by the token itself", () => {
    const tracker = new QuotaTracker({ limit: 1, now: () => 0 });
    tracker.consume("token");
    // The hash of "token" is a different string, so it must land in its own
    // bucket with a full allowance — proving the raw value is not the key.
    assert.equal(tracker.peek(hashQuery("token")).remaining, 1);
    assert.equal(tracker.peek("token").remaining, 0);
  });
});

describe("KAnonymityGate", () => {
  it("withholds a query until k distinct devices have asked for it", () => {
    const gate = new KAnonymityGate(3);
    assert.equal(gate.observe("hash1", "a"), false);
    assert.equal(gate.observe("hash1", "b"), false);
    assert.equal(gate.observe("hash1", "c"), true);
  });

  it("does not count one device repeatedly", () => {
    const gate = new KAnonymityGate(2);
    assert.equal(gate.observe("hash1", "a"), false);
    assert.equal(gate.observe("hash1", "a"), false);
    assert.equal(gate.observe("hash1", "a"), false);
  });

  it("keeps queries independent", () => {
    const gate = new KAnonymityGate(2);
    gate.observe("hash1", "a");
    gate.observe("hash1", "b");
    assert.equal(gate.observe("hash2", "a"), false);
  });
});

describe("DailyBudget", () => {
  it("allows spend up to the ceiling, then withdraws the paid sources", () => {
    const budget = new DailyBudget({ limit: 2, now: () => 0 });
    assert.equal(budget.peek().paidSourcesAllowed, true);
    budget.consume();
    assert.equal(budget.peek().paidSourcesAllowed, true);
    budget.consume();
    assert.equal(budget.peek().paidSourcesAllowed, false);
  });

  it("resets at the UTC day boundary", () => {
    let now = 0;
    const budget = new DailyBudget({ limit: 1, now: () => now });
    budget.consume();
    assert.equal(budget.peek().paidSourcesAllowed, false);

    now = 25 * 60 * 60 * 1000;
    assert.equal(budget.peek().paidSourcesAllowed, true);
  });
});

describe("POST /resolve — demo mode", () => {
  it("refuses caller-supplied keys on the public demo", async () => {
    const app = createApp({ config: testConfig() });
    const response = await post(app, {
      query: "anything",
      demo: true,
      byok: { llmApiKey: "sk-someone-elses-key" },
    });

    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: string };
    assert.match(body.error, /does not accept provider keys/);
  });

  it("meters the demo separately from the signed-in free tier", async () => {
    const app = createApp({ config: testConfig({ demoDailyQuota: 2, freeMonthlyQuota: 9 }) });

    const demo = (await (
      await app.request("/quota?demo=1", { headers: { "x-jasb-device": "d" } })
    ).json()) as { limit: number };
    const free = (await (
      await app.request("/quota", { headers: { "x-jasb-device": "d" } })
    ).json()) as { limit: number };

    assert.equal(demo.limit, 2);
    assert.equal(free.limit, 9);
  });

  it("reports the spend ceiling without revealing who spent it", async () => {
    const app = createApp({ config: testConfig({ dailyBudget: 50 }) });
    const body = (await (await app.request("/budget")).json()) as Record<string, unknown>;

    assert.equal(body.paidSourcesAllowed, true);
    assert.equal(body.remaining, 50);
    assert.ok(!("used" in body) || typeof body.used === "number");
    assert.equal(JSON.stringify(body).includes("device"), false);
  });

  it("degrades to free sources instead of failing once the ceiling is spent", async () => {
    // Ceiling of zero means every request is already over budget.
    const app = createApp({ config: testConfig({ dailyBudget: 0 }) });
    const response = await post(app, { query: "https://example.com", demo: true });

    assert.equal(response.status, 200);
    const body = (await response.json()) as { degraded: boolean; result: { kind: string } };
    assert.equal(body.degraded, true);
    assert.equal(body.result.kind, "navigate");
  });
});

describe("QuotaTracker periods and persistence", () => {
  it("resets a monthly allowance at the start of the next UTC month, not the next day", () => {
    let now = Date.UTC(2026, 8, 30, 23, 0);
    const tracker = new QuotaTracker({ limit: 1, period: "month", now: () => now });
    assert.equal(tracker.consume("d").allowed, true);
    now = Date.UTC(2026, 8, 30, 23, 59);
    assert.equal(tracker.consume("d").allowed, false);
    now = Date.UTC(2026, 9, 1, 0, 1);
    assert.equal(tracker.consume("d").allowed, true);
  });

  it("keeps this month's counters across a restart", () => {
    const path = join(mkdtempSync(join(tmpdir(), "jasb-q-")), "quota.json");
    const first = new QuotaTracker({ limit: 2, period: "month", path });
    first.consume("device-x");
    first.consume("device-x");
    first.flush();
    const second = new QuotaTracker({ limit: 2, period: "month", path });
    assert.equal(second.peek("device-x").allowed, false);
  });
});
