/**
 * Paddle Billing webhooks.
 *
 * Paddle is the merchant of record: it takes the card, the tax and the
 * invoice. We only need to hear two things back, "this was paid for" and "this
 * subscription stopped", and turn them into licence state.
 *
 * Every webhook is signed. An unsigned or stale one is rejected before its
 * body is even parsed, because an unauthenticated "transaction.completed"
 * would be a free licence generator.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import type { LicenseStore, Plan } from "./licenses.ts";

/** Replay window. Wide enough for clock drift and Paddle's retries, narrow enough that a captured request goes stale. */
const MAX_SKEW_SECONDS = 300;

/**
 * Checks a `Paddle-Signature: ts=…;h1=…` header against the raw body.
 * More than one `h1` appears while a secret is being rotated; any match passes.
 */
export function verifyPaddleSignature(
  rawBody: string,
  header: string | undefined,
  secret: string,
  nowMs = Date.now(),
): boolean {
  if (!header || !secret) return false;

  let timestamp: string | undefined;
  const signatures: string[] = [];
  for (const part of header.split(";")) {
    const [name, value] = part.split("=", 2).map((piece) => piece?.trim());
    if (name === "ts") timestamp = value;
    if (name === "h1" && value) signatures.push(value);
  }
  if (!timestamp || signatures.length === 0) return false;

  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds) || Math.abs(nowMs / 1000 - seconds) > MAX_SKEW_SECONDS) {
    return false;
  }

  const expected = createHmac("sha256", secret).update(`${timestamp}:${rawBody}`).digest();
  return signatures.some((signature) => {
    const given = Buffer.from(signature, "hex");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

interface PaddleEvent {
  event_type?: string;
  data?: {
    id?: string;
    status?: string;
    subscription_id?: string | null;
    custom_data?: Record<string, unknown> | null;
    items?: { price?: { id?: string } | null }[];
  };
}

export interface PaddlePrices {
  pro?: string;
  supporter?: string;
}

/** Subscription states in which the customer is still paying, or still inside a grace period. */
const BILLABLE = new Set(["active", "trialing", "past_due"]);

/**
 * Applies one verified event to the store. Returns a short description for
 * the response body; Paddle shows it in the dashboard's delivery log, which
 * makes a misconfigured price id obvious.
 */
export function applyPaddleEvent(
  event: PaddleEvent,
  store: LicenseStore,
  prices: PaddlePrices,
): string {
  const type = event.event_type ?? "";
  const data = event.data ?? {};

  if (type === "transaction.completed") {
    if (!data.id) return "ignored: transaction without id";

    const priceIds = (data.items ?? []).map((item) => item.price?.id).filter(Boolean);
    const plan: Plan | undefined = priceIds.includes(prices.pro)
      ? "pro"
      : priceIds.includes(prices.supporter)
        ? "supporter"
        : undefined;
    if (!plan) return `ignored: no known price in ${priceIds.join(",") || "transaction"}`;

    const claim = data.custom_data?.claim;
    const recorded = store.recordPurchase({
      transactionId: data.id,
      plan,
      ...(typeof claim === "string" && claim ? { claimToken: claim } : {}),
      ...(data.subscription_id ? { subscriptionId: data.subscription_id } : {}),
    });
    return recorded ? `recorded ${plan}` : "duplicate";
  }

  if (type.startsWith("subscription.")) {
    if (!data.id || !data.status) return "ignored: subscription without id or status";
    const changed = store.setSubscriptionActive(data.id, BILLABLE.has(data.status));
    return changed ? `subscription ${data.status}` : "no change";
  }

  return `ignored: ${type || "unknown event"}`;
}
