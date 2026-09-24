/**
 * Server client for the extension.
 *
 * Same `POST /resolve` contract as the web app. The device token lives in
 * extension storage rather than `localStorage`, and BYOK keys ride along per
 * request exactly as they do everywhere else.
 */

import type { ResolveResult } from "@jasb/intent-engine";

import { loadByok, loadLicense } from "./rules.ts";

const KEY_DEVICE = "jasb.device";
const KEY_SERVER = "jasb.server";

/**
 * Baked in at build time. The manifest's `host_permissions` is generated from
 * the same value (see vite.config.ts), so the two cannot disagree.
 */
const DEFAULT_SERVER =
  (import.meta.env.VITE_JASB_SERVER as string | undefined) ?? "https://api.jasb.dev";

export async function serverEndpoint(): Promise<string> {
  const stored = await chrome.storage.local.get(KEY_SERVER);
  const value = stored[KEY_SERVER];
  return typeof value === "string" && value ? value : DEFAULT_SERVER;
}

export async function setServerEndpoint(url: string): Promise<void> {
  await chrome.storage.local.set({ [KEY_SERVER]: url });
}

async function deviceToken(): Promise<string> {
  const stored = await chrome.storage.local.get(KEY_DEVICE);
  const existing = stored[KEY_DEVICE];
  if (typeof existing === "string" && existing) return existing;

  const token = crypto.randomUUID();
  await chrome.storage.local.set({ [KEY_DEVICE]: token });
  return token;
}

export async function resolveViaServer(
  query: string,
  options: { refresh?: boolean } = {},
): Promise<ResolveResult> {
  const [endpoint, device, byok, license] = await Promise.all([
    serverEndpoint(),
    deviceToken(),
    loadByok(),
    loadLicense(),
  ]);

  const payload: Record<string, unknown> = {
    query,
    locale: chrome.i18n?.getUILanguage?.() ?? navigator.language,
    ...(options.refresh ? { refresh: true } : {}),
  };

  const keys = Object.fromEntries(
    Object.entries(byok).filter(([, value]) => typeof value === "string" && value.trim()),
  );
  if (Object.keys(keys).length > 0) payload.byok = keys;

  const response = await fetch(`${endpoint}/resolve`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-jasb-device": device,
      ...(license ? { "x-jasb-license": license } : {}),
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `server returned ${response.status}`);
  }

  const body = (await response.json()) as { result: ResolveResult };
  return body.result;
}

export type LicenseCheck =
  | { status: "valid"; plan: "pro" | "supporter"; active: boolean }
  | { status: "unknown" }
  | { status: "unreachable" };

export async function checkLicense(key: string): Promise<LicenseCheck> {
  try {
    const response = await fetch(`${await serverEndpoint()}/license`, {
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
