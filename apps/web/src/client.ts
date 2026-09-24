/**
 * The client half of the `POST /resolve` contract.
 *
 * Deliberately thin. All the ranking intelligence lives in the engine — this
 * file only decides *where* the engine runs: on our server (shared cache, free
 * quota) or in this tab against the user's own keys (nothing leaves except the
 * provider calls the user is paying for).
 */

import { type ResolveResult } from "@jasb/intent-engine";

import { deviceToken, hasByok, readByok, readLicense, type ByokSettings } from "./storage.ts";

export interface QuotaState {
  allowed: boolean;
  remaining: number;
  limit: number;
  resetInSeconds: number;
  plan?: "free" | "pro" | "demo";
}

export interface ResolveResponse {
  result: ResolveResult;
  quota: QuotaState;
}

export class QuotaExceededError extends Error {
  readonly quota: QuotaState;
  constructor(quota: QuotaState) {
    super("daily free quota reached");
    this.name = "QuotaExceededError";
    this.quota = quota;
  }
}

const serverUrl: string =
  (import.meta.env?.VITE_JASB_SERVER as string | undefined) ??
  (import.meta.env?.DEV ? "http://localhost:8787" : "https://api.jasb.dev");

/** The device token always; the licence key when there is one. */
function identity(): Record<string, string> {
  const license = readLicense();
  return { "x-jasb-device": deviceToken(), ...(license ? { "x-jasb-license": license } : {}) };
}

export interface ResolveArgs {
  query: string;
  refresh?: boolean;
  maxCards?: number;
  signal?: AbortSignal;
}

export async function resolve(args: ResolveArgs): Promise<ResolveResponse> {
  const byok = readByok();

  const response = await fetch(`${serverUrl}/resolve`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...identity(),
    },
    body: JSON.stringify({
      query: args.query,
      ...(args.refresh ? { refresh: true } : {}),
      ...(args.maxCards ? { maxCards: args.maxCards } : {}),
      locale: navigator.language,
      // Keys are sent per request and never persisted server-side. The
      // settings panel says so plainly, because the user should know their key
      // transits our host even in BYOK mode.
      ...(hasByok(byok) ? { byok: toByokPayload(byok) } : {}),
    }),
    ...(args.signal ? { signal: args.signal } : {}),
  });

  if (response.status === 429) {
    const body = (await response.json()) as { quota: QuotaState };
    throw new QuotaExceededError(body.quota);
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `server returned ${response.status}`);
  }

  return (await response.json()) as ResolveResponse;
}

export async function fetchQuota(): Promise<QuotaState | undefined> {
  try {
    const response = await fetch(`${serverUrl}/quota`, {
      headers: identity(),
    });
    if (!response.ok) return undefined;
    return (await response.json()) as QuotaState;
  } catch {
    // The server being unreachable is not worth an error banner on its own —
    // the next search will surface it with a message that can actually help.
    return undefined;
  }
}

export type LicenseCheck =
  | { status: "valid"; plan: "pro" | "supporter"; active: boolean }
  | { status: "unknown" }
  | { status: "unreachable" };

export async function checkLicense(key: string): Promise<LicenseCheck> {
  try {
    const response = await fetch(`${serverUrl}/license`, {
      headers: { "x-jasb-license": key.trim().toLowerCase() },
    });
    if (response.status === 404) return { status: "unknown" };
    if (!response.ok) return { status: "unreachable" };
    const body = (await response.json()) as { plan: "pro" | "supporter"; active: boolean };
    return { status: "valid", plan: body.plan, active: body.active };
  } catch {
    return { status: "unreachable" };
  }
}

export async function serverReachable(): Promise<boolean> {
  try {
    const response = await fetch(`${serverUrl}/health`);
    return response.ok;
  } catch {
    return false;
  }
}

/** Drops empty strings so a half-filled settings form is not treated as BYOK. */
function toByokPayload(settings: ByokSettings): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (typeof value === "string" && value.trim()) out[key] = value.trim();
  }
  return out;
}

export { serverUrl };
