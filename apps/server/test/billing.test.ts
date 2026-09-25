import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createApp } from "../src/app.ts";
import { loadConfig, type ServerConfig } from "../src/config.ts";
import { LicenseStore, mintKey } from "../src/licenses.ts";
import { verifyPaddleSignature } from "../src/paddle.ts";

const SECRET = "pdl_ntfset_test_secret";
const NOW = 1_780_000_000_000;

function billingConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    ...loadConfig(),
    port: 0,
    allowedOrigins: ["*"],
    freeMonthlyQuota: 1,
    starterMonthlyQuota: 30,
    proMonthlyQuota: 50,
    stateDir: mkdtempSync(join(tmpdir(), "jasb-test-")),
    paddle: {
      environment: "sandbox",
      clientToken: "test_client_token",
      webhookSecret: SECRET,
      prices: {
        starter: ["pri_starter"],
        pro: ["pri_pro", "pri_pro_yearly"],
        supporter: ["pri_supporter"],
      },
    },
    ...overrides,
  };
}

function sign(body: string, secret = SECRET, ts = Math.floor(NOW / 1000)) {
  const h1 = createHmac("sha256", secret).update(`${ts}:${body}`).digest("hex");
  return `ts=${ts};h1=${h1}`;
}

function webhook(app: ReturnType<typeof createApp>, event: unknown, signature?: string) {
  const body = JSON.stringify(event);
  return app.request("/billing/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "paddle-signature": signature ?? sign(body) },
    body,
  });
}

function completed(id: string, price: string, extra: Record<string, unknown> = {}) {
  return {
    event_type: "transaction.completed",
    data: { id, items: [{ price: { id: price } }], ...extra },
  };
}

function setup() {
  const licenses = new LicenseStore({ now: () => NOW });
  const app = createApp({ config: billingConfig(), licenses, now: () => NOW });
  return { app, licenses };
}

describe("verifyPaddleSignature", () => {
  it("accepts a correct signature and rejects everything else", () => {
    const body = '{"a":1}';
    assert.equal(verifyPaddleSignature(body, sign(body), SECRET, NOW), true);
    assert.equal(verifyPaddleSignature(body, sign(body, "wrong"), SECRET, NOW), false);
    assert.equal(verifyPaddleSignature('{"a":2}', sign(body), SECRET, NOW), false);
    assert.equal(verifyPaddleSignature(body, undefined, SECRET, NOW), false);
    assert.equal(verifyPaddleSignature(body, "ts=1;h1=zz", SECRET, NOW), false);
  });

  it("rejects a replayed signature outside the window", () => {
    const body = "{}";
    const stale = sign(body, SECRET, Math.floor(NOW / 1000) - 3600);
    assert.equal(verifyPaddleSignature(body, stale, SECRET, NOW), false);
  });

  it("accepts any h1 during secret rotation", () => {
    const body = "{}";
    const ts = Math.floor(NOW / 1000);
    const good = sign(body).split(";h1=")[1];
    assert.equal(verifyPaddleSignature(body, `ts=${ts};h1=${"0".repeat(64)};h1=${good}`, SECRET, NOW), true);
  });
});

describe("billing routes", () => {
  it("stays off until the configuration is complete", async () => {
    const app = createApp({
      config: billingConfig({
        paddle: { environment: "sandbox", prices: { starter: [], pro: [], supporter: [] } },
      }),
      licenses: new LicenseStore(),
    });
    assert.deepEqual(await (await app.request("/billing/config")).json(), { enabled: false });
    assert.equal((await webhook(app, {})).status, 503);
  });

  it("serves the public checkout settings and never the webhook secret", async () => {
    const { app } = setup();
    const text = await (await app.request("/billing/config")).text();
    assert.ok(text.includes("test_client_token"));
    assert.ok(!text.includes(SECRET));
  });

  it("rejects an unsigned webhook", async () => {
    const { app } = setup();
    const response = await webhook(app, completed("txn_1", "pri_pro"), "ts=1;h1=00");
    assert.equal(response.status, 401);
  });

  it("mints a Pro key a claim can pick up, and the key lifts the quota", async () => {
    const { app } = setup();

    const pending = await app.request("/billing/claim?token=claim-123");
    assert.equal(pending.status, 404);

    const hook = await webhook(
      app,
      completed("txn_1", "pri_pro", { subscription_id: "sub_1", custom_data: { claim: "claim-123" } }),
    );
    assert.equal(hook.status, 200);

    const claimed = (await (await app.request("/billing/claim?token=claim-123")).json()) as {
      key: string;
      plan: string;
    };
    assert.equal(claimed.plan, "pro");
    assert.match(claimed.key, /^jasb-[a-z2-9]{5}(-[a-z2-9]{5}){3}$/);

    const check = await app.request("/license", { headers: { "x-jasb-license": claimed.key } });
    assert.deepEqual(await check.json(), { valid: true, plan: "pro", active: true });

    const quota = await app.request("/quota", {
      headers: { "x-jasb-device": "d1", "x-jasb-license": claimed.key },
    });
    const body = (await quota.json()) as { limit: number; plan: string };
    assert.equal(body.plan, "pro");
    assert.equal(body.limit, 50);
  });

  it("treats a retried webhook as a duplicate", async () => {
    const { app } = setup();
    const event = completed("txn_1", "pri_supporter", { custom_data: { claim: "c" } });
    await webhook(app, event);
    const again = (await (await webhook(app, event)).json()) as { outcome: string };
    assert.equal(again.outcome, "duplicate");
  });

  it("ignores a transaction for a price it does not sell", async () => {
    const { app, licenses } = setup();
    const response = (await (await webhook(app, completed("txn_x", "pri_other"))).json()) as {
      outcome: string;
    };
    assert.match(response.outcome, /^ignored/);
    assert.equal(licenses.claim("anything"), undefined);
  });

  it("keeps one key through renewals and follows cancellation", async () => {
    const { app } = setup();
    await webhook(app, completed("txn_1", "pri_pro", { subscription_id: "sub_1", custom_data: { claim: "c1" } }));
    const { key } = (await (await app.request("/billing/claim?token=c1")).json()) as { key: string };

    // A renewal carries the same claim but must not mint a second key.
    await webhook(app, completed("txn_2", "pri_pro", { subscription_id: "sub_1", custom_data: { claim: "c2" } }));
    assert.equal((await app.request("/billing/claim?token=c2")).status, 404);

    await webhook(app, { event_type: "subscription.canceled", data: { id: "sub_1", status: "canceled" } });
    const after = await app.request("/quota", { headers: { "x-jasb-device": "d1", "x-jasb-license": key } });
    assert.equal(((await after.json()) as { plan: string }).plan, "free");

    await webhook(app, { event_type: "subscription.updated", data: { id: "sub_1", status: "active" } });
    const back = await app.request("/quota", { headers: { "x-jasb-device": "d1", "x-jasb-license": key } });
    assert.equal(((await back.json()) as { plan: string }).plan, "pro");
  });

  it("gives a Supporter key the free quota: it is for people on their own keys", async () => {
    const { app } = setup();
    await webhook(app, completed("txn_s", "pri_supporter", { custom_data: { claim: "s" } }));
    const { key } = (await (await app.request("/billing/claim?token=s")).json()) as { key: string };
    const quota = await app.request("/quota", { headers: { "x-jasb-device": "d1", "x-jasb-license": key } });
    assert.equal(((await quota.json()) as { plan: string }).plan, "free");
  });
});

describe("plans", () => {
  it("meters a Starter key monthly against its own allowance", async () => {
    const { app } = setup();
    await webhook(app, completed("txn_st", "pri_starter", { subscription_id: "sub_st", custom_data: { claim: "st" } }));
    const { key } = (await (await app.request("/billing/claim?token=st")).json()) as { key: string };
    const body = (await (
      await app.request("/quota", { headers: { "x-jasb-device": "d1", "x-jasb-license": key } })
    ).json()) as { plan: string; limit: number; period: string };
    assert.deepEqual([body.plan, body.limit, body.period], ["starter", 30, "month"]);
  });

  it("recognises the yearly Pro price as Pro", async () => {
    const { app } = setup();
    await webhook(app, completed("txn_y", "pri_pro_yearly", { subscription_id: "sub_y", custom_data: { claim: "y" } }));
    const claimed = (await (await app.request("/billing/claim?token=y")).json()) as { plan: string };
    assert.equal(claimed.plan, "pro");
  });

  it("gives devices without a licence the monthly free allowance", async () => {
    const { app } = setup();
    const body = (await (await app.request("/quota", { headers: { "x-jasb-device": "d9" } })).json()) as {
      plan: string;
      period: string;
    };
    assert.deepEqual([body.plan, body.period], ["free", "month"]);
  });
});

describe("LicenseStore persistence", () => {
  it("survives a restart and stores no key in the clear", () => {
    const path = join(mkdtempSync(join(tmpdir(), "jasb-")), "licenses.json");
    const first = new LicenseStore({ path });
    first.recordPurchase({ transactionId: "txn_1", plan: "pro", claimToken: "tok", subscriptionId: "sub_1" });
    const key = first.claim("tok")!.key;

    const second = new LicenseStore({ path });
    assert.equal(second.lookup(key)?.plan, "pro");
    assert.equal(second.lookup(key.toUpperCase())?.plan, "pro");

    // The key still sits in the claim until it expires; the licence map must not hold it.
    const state = JSON.parse(readFileSync(path, "utf8")) as { licenses: Record<string, unknown> };
    assert.ok(!JSON.stringify(state.licenses).includes(key));
  });

  it("mints distinct keys", () => {
    const keys = new Set(Array.from({ length: 1000 }, mintKey));
    assert.equal(keys.size, 1000);
  });
});

describe("LicenseStore claim expiry", () => {
  it("deletes an unclaimed key after seven days, even if nobody asks for it", () => {
    let now = NOW;
    const path = join(mkdtempSync(join(tmpdir(), "jasb-")), "licenses.json");
    const store = new LicenseStore({ path, now: () => now });
    store.recordPurchase({ transactionId: "txn_1", plan: "supporter", claimToken: "tok" });
    const key = store.claim("tok")!.key;

    now += 8 * 24 * 60 * 60 * 1000;
    new LicenseStore({ path, now: () => now });
    assert.ok(!readFileSync(path, "utf8").includes(key));
  });
});
