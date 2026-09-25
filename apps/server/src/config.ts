/**
 * Server configuration, read once from the environment.
 *
 * Everything is optional. With no keys at all the server still runs and still
 * serves results — it falls back to a public SearxNG-style setup and a keyword
 * heuristic — because a config error should degrade the product, not take it
 * down.
 */

import type { SystemOnePreset } from "@jasb/intent-engine";

export interface ServerConfig {
  port: number;
  /**
   * Interface to bind. Everything in development; `127.0.0.1` in production,
   * where Caddy is the only thing that should reach the process.
   */
  host: string;
  /** Origins allowed to call `/resolve`. `*` in dev, explicit list in production. */
  allowedOrigins: string[];

  /**
   * The decision layer. Jev is hosted and closed, so the default here is a
   * self-hosted open model speaking the same `POST /v1/systemone` contract —
   * `kev`, `clm`, `von` or `decider`.
   */
  systemOnePreset?: SystemOnePreset;
  systemOneUrl?: string;
  systemOneModel?: string;
  systemOneApiKey?: string;

  llmProvider?: "anthropic" | "openai" | "openrouter" | "gemini" | "ollama";
  llmApiKey?: string;
  llmModel?: string;

  braveApiKey?: string;
  serperApiKey?: string;
  searxngUrl?: string;
  marginaliaApiKey?: string;

  /**
   * Jasb Search allowances, per month, Kagi-style. URL, bang and cache hits
   * are never counted. Free is per device; paid plans are per licence, so one
   * subscription covers every machine it is used on.
   */
  freeMonthlyQuota: number;
  starterMonthlyQuota: number;
  /** "Unlimited" is a fair-use ceiling, not a hard product limit. */
  proMonthlyQuota: number;
  /**
   * Searches per device per day for anonymous visitors on the public demo.
   * Lower than the free tier: the demo exists to prove the product works, not
   * to be a free tier with extra steps.
   */
  demoDailyQuota: number;
  /**
   * Hard ceiling on billable resolutions per day across every visitor. Past
   * it the demo drops to free sources instead of spending or failing.
   */
  dailyBudget: number;
  /**
   * Refuse caller-supplied provider keys. Set on the public deployment:
   * accepting a stranger's key on an open endpoint is a liability, not a
   * feature, and the demo has no use for one.
   */
  refuseByok: boolean;
  /**
   * A query is written to the shared cache only once this many distinct devices
   * have asked for it. The k-anonymity threshold from the privacy design.
   */
  sharedCacheK: number;

  /**
   * Paddle Billing. Checkout stays switched off until the webhook secret, the
   * client-side token and at least one price id are all present.
   */
  paddle: {
    environment: "sandbox" | "production";
    /** Public, safe in the browser: Paddle.js needs it to open checkout. */
    clientToken?: string;
    webhookSecret?: string;
    /** Price ids per plan. Several are allowed (monthly and yearly Pro). */
    prices: { starter: string[]; pro: string[]; supporter: string[] };
  };
  /** Where the licence store lives. `/var/lib/jasb` in production. */
  stateDir: string;
}

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

/** A comma-separated env var as a list, empty entries dropped. */
function list(name: string): string[] {
  return (optional(name) ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function integer(name: string, fallback: number): number {
  const raw = optional(name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadConfig(): ServerConfig {
  const provider = optional("JASB_LLM_PROVIDER") as ServerConfig["llmProvider"];
  const preset = optional("JASB_SYSTEM_ONE_PRESET") as SystemOnePreset | undefined;

  return {
    port: integer("PORT", 8787),
    host: optional("JASB_HOST") ?? "0.0.0.0",
    allowedOrigins: (optional("JASB_ALLOWED_ORIGINS") ?? "*")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),

    ...(preset ? { systemOnePreset: preset } : {}),
    ...(optional("JASB_SYSTEM_ONE_URL") ? { systemOneUrl: optional("JASB_SYSTEM_ONE_URL") } : {}),
    ...(optional("JASB_SYSTEM_ONE_MODEL")
      ? { systemOneModel: optional("JASB_SYSTEM_ONE_MODEL") }
      : {}),
    ...(optional("JASB_SYSTEM_ONE_API_KEY")
      ? { systemOneApiKey: optional("JASB_SYSTEM_ONE_API_KEY") }
      : {}),

    ...(provider ? { llmProvider: provider } : {}),
    ...(optional("JASB_LLM_API_KEY") ? { llmApiKey: optional("JASB_LLM_API_KEY") } : {}),
    ...(optional("JASB_LLM_MODEL") ? { llmModel: optional("JASB_LLM_MODEL") } : {}),

    ...(optional("JASB_BRAVE_API_KEY") ? { braveApiKey: optional("JASB_BRAVE_API_KEY") } : {}),
    ...(optional("JASB_SERPER_API_KEY") ? { serperApiKey: optional("JASB_SERPER_API_KEY") } : {}),
    ...(optional("JASB_SEARXNG_URL") ? { searxngUrl: optional("JASB_SEARXNG_URL") } : {}),
    ...(optional("JASB_MARGINALIA_API_KEY")
      ? { marginaliaApiKey: optional("JASB_MARGINALIA_API_KEY") }
      : {}),

    freeMonthlyQuota: integer("JASB_FREE_MONTHLY_QUOTA", 50),
    starterMonthlyQuota: integer("JASB_STARTER_MONTHLY_QUOTA", 300),
    proMonthlyQuota: integer("JASB_PRO_MONTHLY_QUOTA", 2_000),
    demoDailyQuota: integer("JASB_DEMO_DAILY_QUOTA", 5),
    dailyBudget: integer("JASB_DAILY_BUDGET", 2_000),
    refuseByok: (optional("JASB_REFUSE_BYOK") ?? "false") === "true",
    sharedCacheK: integer("JASB_SHARED_CACHE_K", 3),

    paddle: {
      environment: optional("JASB_PADDLE_ENV") === "production" ? "production" : "sandbox",
      ...(optional("JASB_PADDLE_CLIENT_TOKEN")
        ? { clientToken: optional("JASB_PADDLE_CLIENT_TOKEN") }
        : {}),
      ...(optional("JASB_PADDLE_WEBHOOK_SECRET")
        ? { webhookSecret: optional("JASB_PADDLE_WEBHOOK_SECRET") }
        : {}),
      prices: {
        starter: list("JASB_PADDLE_PRICE_STARTER"),
        pro: list("JASB_PADDLE_PRICE_PRO"),
        supporter: list("JASB_PADDLE_PRICE_SUPPORTER"),
      },
    },
    // STATE_DIRECTORY is set by systemd's StateDirectory=.
    stateDir: optional("JASB_STATE_DIR") ?? optional("STATE_DIRECTORY") ?? ".state",
  };
}

export function billingEnabled(config: ServerConfig): boolean {
  const { paddle } = config;
  return Boolean(
    paddle.clientToken &&
      paddle.webhookSecret &&
      (paddle.prices.starter.length || paddle.prices.pro.length || paddle.prices.supporter.length),
  );
}

/** Human-readable summary for the startup banner. Never prints a key. */
export function describeConfig(config: ServerConfig): string {
  const decider = config.systemOneUrl || config.systemOnePreset
    ? `system-one:${config.systemOnePreset ?? "custom"}`
    : config.llmApiKey
      ? `llm:${config.llmProvider ?? "anthropic"}`
      : "none (keyword heuristic only)";

  const sources = [
    config.braveApiKey && "brave",
    config.serperApiKey && "serper",
    config.searxngUrl && "searxng",
    "wikipedia",
    "marginalia",
  ].filter(Boolean);

  const billing = billingEnabled(config) ? `paddle:${config.paddle.environment}` : "off";
  return `decider=${decider} sources=${sources.join(",")} free=${config.freeMonthlyQuota}/month billing=${billing}`;
}
