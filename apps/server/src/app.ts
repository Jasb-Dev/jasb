/**
 * The HTTP surface. No database, no sessions, no logs of content.
 *
 * `POST /resolve` is the whole contract between every client and the server,
 * and it returns exactly what `IntentEngine.resolve()` returns — so the web
 * app, the extension and the desktop shell render identical results whether
 * the engine ran here or in-process on the user's machine.
 */

import { hashQuery, type ResolveResult } from "@jasb/intent-engine";
import { Hono } from "hono";
import { cors } from "hono/cors";

import { join } from "node:path";

import { billingEnabled, describeConfig, type ServerConfig } from "./config.ts";
import { buildEngine, privacyLogger, sharedCache, type ByokKeys } from "./engine.ts";
import { DailyBudget } from "./budget.ts";
import { KAnonymityGate, QuotaTracker } from "./quota.ts";
import { LicenseStore } from "./licenses.ts";
import { applyPaddleEvent, verifyPaddleSignature } from "./paddle.ts";

export interface AppOptions {
  config: ServerConfig;
  /** Defaults to a file under `config.stateDir`. Tests pass an in-memory one. */
  licenses?: LicenseStore;
  now?: () => number;
}

interface ResolveBody {
  query?: string;
  /** Set by the public "try it" box. Gets the smaller quota, never BYOK. */
  demo?: boolean;
  maxCards?: number;
  refresh?: boolean;
  locale?: string;
  region?: string;
  byok?: ByokKeys;
}

const DEVICE_HEADER = "x-jasb-device";
const LICENSE_HEADER = "x-jasb-license";
const MAX_QUERY_LENGTH = 400;

export function createApp(options: AppOptions) {
  const { config } = options;
  const quota = new QuotaTracker({
    limit: config.freeDailyQuota,
    ...(options.now ? { now: options.now } : {}),
  });
  const demoQuota = new QuotaTracker({
    limit: config.demoDailyQuota,
    ...(options.now ? { now: options.now } : {}),
  });
  const budget = new DailyBudget({
    limit: config.dailyBudget,
    ...(options.now ? { now: options.now } : {}),
  });
  // Keyed by licence rather than device, so fair use is per subscription
  // however many machines it is used on.
  const proQuota = new QuotaTracker({
    limit: config.proDailyQuota,
    ...(options.now ? { now: options.now } : {}),
  });
  const kGate = new KAnonymityGate(config.sharedCacheK);
  const licenses =
    options.licenses ??
    new LicenseStore({
      path: join(config.stateDir, "licenses.json"),
      ...(options.now ? { now: options.now } : {}),
    });

  /** The meter a request is charged against, and the id it is charged to. */
  function meterFor(device: string, licenseKey: string | undefined, demo: boolean) {
    if (demo) return { tracker: demoQuota, id: device, plan: "demo" as const };
    const license = licenses.lookup(licenseKey);
    if (license?.active && license.plan === "pro") {
      return { tracker: proQuota, id: licenseKey!.trim().toLowerCase(), plan: "pro" as const };
    }
    return { tracker: quota, id: device, plan: "free" as const };
  }

  const app = new Hono();

  app.use(
    "*",
    cors({
      origin: config.allowedOrigins.includes("*") ? "*" : config.allowedOrigins,
      allowHeaders: ["content-type", DEVICE_HEADER, LICENSE_HEADER],
      allowMethods: ["GET", "POST", "OPTIONS"],
      maxAge: 86_400,
    }),
  );

  app.get("/health", (c) =>
    c.json({
      ok: true,
      service: "jasb",
      configuration: describeConfig(config),
    }),
  );

  /**
   * What we store and what we do not. Served as data so the client can render
   * the privacy label without the two drifting apart.
   */
  app.get("/privacy", (c) =>
    c.json({
      logsQueries: false,
      logsIpAddresses: false,
      requiresAccount: false,
      telemetry: "none",
      sharedCache: {
        stores: "query hash → ranked card list",
        excludes: "device identity, IP, raw query text",
        kAnonymityThreshold: config.sharedCacheK,
      },
      byok: "keys are used for the single request and never written to disk",
      licenses: {
        stores: "sha256 of the key, plan, active flag, Paddle subscription id",
        excludes: "name, email, country, queries",
        unclaimedKeyRetentionDays: 7,
      },
    }),
  );

  app.get("/quota", (c) => {
    const device = c.req.header(DEVICE_HEADER);
    if (!device) return c.json({ error: "missing device token" }, 400);
    const meter = meterFor(device, c.req.header(LICENSE_HEADER), c.req.query("demo") === "1");
    return c.json({ ...meter.tracker.peek(meter.id), plan: meter.plan });
  });

  // --- Billing ---------------------------------------------------------------

  /**
   * What the site needs to open checkout. Served rather than baked into the
   * build, so turning billing on is an env change and a restart, not a rebuild.
   */
  app.get("/billing/config", (c) => {
    if (!billingEnabled(config)) return c.json({ enabled: false });
    return c.json({
      enabled: true,
      environment: config.paddle.environment,
      clientToken: config.paddle.clientToken,
      prices: config.paddle.prices,
    });
  });

  app.post("/billing/webhook", async (c) => {
    const secret = config.paddle.webhookSecret;
    if (!secret) return c.json({ error: "billing is not configured" }, 503);

    // The signature covers the exact bytes Paddle sent; parse only afterwards.
    const raw = await c.req.text();
    const now = options.now ? options.now() : Date.now();
    if (!verifyPaddleSignature(raw, c.req.header("paddle-signature"), secret, now)) {
      return c.json({ error: "invalid signature" }, 401);
    }

    let event: Parameters<typeof applyPaddleEvent>[0];
    try {
      event = JSON.parse(raw);
    } catch {
      return c.json({ error: "body must be JSON" }, 400);
    }

    const outcome = applyPaddleEvent(event, licenses, config.paddle.prices);
    return c.json({ ok: true, outcome });
  });

  /** Polled by the success page until the webhook has minted the key. */
  app.get("/billing/claim", (c) => {
    const claimed = licenses.claim(c.req.query("token"));
    if (!claimed) return c.json({ status: "pending" }, 404);
    return c.json({ status: "ready", ...claimed });
  });

  /** Lets a client check a pasted key before saving it. */
  app.get("/license", (c) => {
    const license = licenses.lookup(c.req.header(LICENSE_HEADER));
    if (!license) return c.json({ valid: false }, 404);
    return c.json({ valid: true, plan: license.plan, active: license.active });
  });

  /**
   * Operational health for the public demo. Deliberately coarse — it reports
   * how much of today's ceiling is gone, never who used it.
   */
  app.get("/budget", (c) => {
    const state = budget.peek();
    return c.json({
      paidSourcesAllowed: state.paidSourcesAllowed,
      remaining: Math.max(0, state.limit - state.used),
      resetInSeconds: state.resetInSeconds,
    });
  });

  app.post("/resolve", async (c) => {
    let body: ResolveBody;
    try {
      body = await c.req.json<ResolveBody>();
    } catch {
      return c.json({ error: "body must be JSON" }, 400);
    }

    const query = (body.query ?? "").trim();
    if (!query) return c.json({ error: "query is required" }, 400);
    if (query.length > MAX_QUERY_LENGTH) {
      return c.json({ error: `query must be at most ${MAX_QUERY_LENGTH} characters` }, 400);
    }

    const device = c.req.header(DEVICE_HEADER);
    if (!device) return c.json({ error: `missing ${DEVICE_HEADER} header` }, 400);

    const isDemo = body.demo === true;

    // A public endpoint must not accept stranger-supplied credentials, and the
    // demo has no use for them — it runs on our keys, under our ceiling.
    if (isDemo && body.byok) {
      return c.json(
        { error: "the demo does not accept provider keys — install the app to use your own" },
        400,
      );
    }
    const byok = config.refuseByok ? undefined : normaliseByok(body.byok);
    const budgetState = budget.peek();

    // Past the daily ceiling the paid sources come out and the free ones stay.
    // A visitor still gets real results, just fewer and shallower.
    const engine = buildEngine(
      config,
      byok,
      budgetState.paidSourcesAllowed ? {} : { freeSourcesOnly: true },
    );

    // The quota exists to bound *our* provider spend. A BYOK request spends the
    // user's own budget, so it is not metered here.
    const meter = meterFor(device, c.req.header(LICENSE_HEADER), isDemo);
    const { tracker } = meter;
    let decision = { allowed: true, remaining: -1, limit: -1, resetInSeconds: 0 };
    if (!byok) {
      // Peek first: URL, bang and cache hits cost us nothing, so we only charge
      // after the engine tells us it actually reached a provider.
      decision = tracker.peek(meter.id);
      if (!decision.allowed) {
        return c.json(
          {
            error: isDemo
              ? "that is all the demo allows today"
              : meter.plan === "pro"
                ? "fair-use limit reached for today"
                : "daily free quota reached",
            quota: decision,
            hint: isDemo
              ? "install the browser or the extension to keep going"
              : "add your own provider key to continue without limits",
          },
          429,
        );
      }
    }

    let result: ResolveResult;
    try {
      result = await engine.resolve(query, {
        ...(body.maxCards ? { maxCards: body.maxCards } : {}),
        ...(body.refresh ? { refresh: true } : {}),
        ...(body.locale ? { locale: body.locale } : {}),
        ...(body.region ? { region: body.region } : {}),
      });
    } catch (error) {
      privacyLogger.error("resolve failed", { error: String(error) });
      return c.json({ error: "resolution failed" }, 502);
    }

    const billable =
      !byok && result.kind === "cards" && !result.cached && result.cards.length > 0;
    if (billable) {
      decision = tracker.consume(meter.id);
      budget.consume();
    }

    if (result.kind === "cards" && !byok) {
      const shareable = kGate.observe(hashQuery(result.query), device);
      if (!shareable) {
        // Below the k-anonymity threshold: drop it from the shared cache so a
        // query only one person has ever made is not retained.
        await sharedCache.delete(hashQuery(result.query)).catch(() => {});
      }
    }

    return c.json({
      result,
      quota: decision,
      // Told plainly so the client can say "showing free sources only" rather
      // than leaving the user to wonder why the grid got thinner.
      degraded: !budgetState.paidSourcesAllowed,
    });
  });

  app.notFound((c) => c.json({ error: "not found" }, 404));

  return app;
}

/**
 * Accepts BYOK keys only when at least one is actually present.
 *
 * An empty `byok: {}` from a client would otherwise silently opt the request
 * out of the shared cache while still spending our keys — worst of both.
 */
function normaliseByok(byok: ByokKeys | undefined): ByokKeys | undefined {
  if (!byok) return undefined;
  const hasKey = Boolean(
    byok.systemOneUrl || byok.llmApiKey || byok.braveApiKey || byok.searxngUrl,
  );
  return hasKey ? byok : undefined;
}
