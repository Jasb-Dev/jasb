/**
 * Jasb Search from the desktop browser.
 *
 * The desktop app runs the engine in process, on the user's own keys, for
 * free. Jasb Search is the alternative for people who would rather not manage
 * keys: the same `POST /resolve` the web app and the extension use, metered
 * per month (free allowance per device, paid plans per licence).
 *
 * Personal ranking stays on this machine either way: the server returns an
 * anonymous card list and the block/pin rules are applied here, after it
 * arrives, exactly as they are in the other clients.
 */

import type { ResolveResult } from "@jasb/intent-engine";
import type { LicenseCheck, LicensePlan } from "@jasb/ui/license";

import type { Rules } from "../shared/ipc.ts";

export const JASB_API = process.env.JASB_API ?? "https://api.jasb.dev";

/** The allowance is used up. Distinct from "unreachable", which falls back to local. */
export class QuotaExceeded extends Error {
  readonly plan: string;
  readonly resetInSeconds: number;
  constructor(plan: string, resetInSeconds: number) {
    super(
      plan === "pro"
        ? "You have reached this month's fair-use limit on Jasb Search."
        : plan === "starter"
          ? "This month's 300 Starter searches are used up."
          : "This month's 50 free Jasb Search searches are used up. Add a licence in Settings, or your own provider keys to search free without limits.",
    );
    this.name = "QuotaExceeded";
    this.plan = plan;
    this.resetInSeconds = resetInSeconds;
  }
}

export async function resolveRemote(args: {
  query: string;
  refresh?: boolean;
  locale: string;
  device: string;
  license?: string;
  rules: Rules;
}): Promise<ResolveResult> {
  const response = await fetch(`${JASB_API}/resolve`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-jasb-device": args.device,
      ...(args.license ? { "x-jasb-license": args.license } : {}),
    },
    body: JSON.stringify({
      query: args.query,
      locale: args.locale,
      ...(args.refresh ? { refresh: true } : {}),
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (response.status === 429) {
    const body = (await response.json().catch(() => ({}))) as {
      plan?: string;
      quota?: { resetInSeconds?: number };
    };
    throw new QuotaExceeded(body.plan ?? "free", body.quota?.resetInSeconds ?? 0);
  }
  if (!response.ok) throw new Error(`Jasb Search returned ${response.status}`);

  const { result } = (await response.json()) as { result: ResolveResult };
  return personalise(result, args.rules);
}

/** Applies this device's block and pin rules to an anonymous result. */
function personalise(result: ResolveResult, rules: Rules): ResolveResult {
  if (result.kind !== "cards") return result;
  const blocked = new Set(rules.blocked);
  const pinned = new Set(rules.pinned);
  const cards = result.cards
    .filter((card) => !blocked.has(card.domain))
    .map((card) => ({ ...card, pinned: pinned.has(card.domain) }))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.score - a.score);
  return { ...result, cards };
}

export async function checkLicenseRemote(key: string): Promise<LicenseCheck> {
  try {
    const response = await fetch(`${JASB_API}/license`, {
      headers: { "x-jasb-license": key.trim().toLowerCase() },
      signal: AbortSignal.timeout(8_000),
    });
    if (response.status === 404) return { status: "unknown" };
    if (!response.ok) return { status: "unreachable" };
    const body = (await response.json()) as { plan: LicensePlan; active: boolean };
    return { status: "valid", plan: body.plan, active: body.active };
  } catch {
    return { status: "unreachable" };
  }
}
