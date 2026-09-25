/**
 * What a licence check means, in words. One source for the web app, the
 * extension and the desktop browser, so the three never describe the same key
 * differently.
 */

export type LicensePlan = "starter" | "pro" | "supporter";

export type LicenseCheck =
  | { status: "valid"; plan: LicensePlan; active: boolean }
  | { status: "unknown" }
  | { status: "unreachable" };

export const PLAN_NAMES: Record<LicensePlan, string> = {
  starter: "Jasb Search Starter",
  pro: "Jasb Search Unlimited",
  supporter: "Lifetime Supporter",
};

export function describeLicense(check: LicenseCheck): { tone: "ok" | "warn"; text: string } {
  switch (check.status) {
    case "unknown":
      return { tone: "warn", text: "That key is not recognised. Check for a typo, or email contact@jasb.dev." };
    case "unreachable":
      return { tone: "warn", text: "Could not reach the server to check the key. It is saved and will be used anyway." };
    case "valid":
      if (check.plan === "supporter") {
        return { tone: "ok", text: "Lifetime Supporter. Thank you for keeping Jasb independent." };
      }
      return check.active
        ? {
            tone: "ok",
            text:
              check.plan === "pro"
                ? `${PLAN_NAMES.pro} is active.`
                : `${PLAN_NAMES.starter} is active: 300 searches a month.`,
          }
        : {
            tone: "warn",
            text: `This ${PLAN_NAMES[check.plan]} subscription is no longer active. Renew it from your Paddle receipt email.`,
          };
  }
}

/** Checks a key against a Jasb server. Never throws. */
export async function checkLicense(server: string, key: string): Promise<LicenseCheck> {
  try {
    const response = await fetch(`${server}/license`, {
      headers: { "x-jasb-license": key.trim().toLowerCase() },
    });
    if (response.status === 404) return { status: "unknown" };
    if (!response.ok) return { status: "unreachable" };
    const body = (await response.json()) as { plan: LicensePlan; active: boolean };
    return { status: "valid", plan: body.plan, active: body.active };
  } catch {
    return { status: "unreachable" };
  }
}
