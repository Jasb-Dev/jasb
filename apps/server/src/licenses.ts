/**
 * Paid entitlements, without accounts.
 *
 * A purchase mints a licence key. The key is shown to the buyer once and
 * stored here only as a hash, next to the plan and the Paddle ids needed to
 * keep it in step with the subscription. There is no email address, no name
 * and no search history in this file, only enough to answer one question: is
 * this key paid for?
 *
 * The buyer's browser never talks to the webhook, so the key reaches them
 * through a claim: the site generates a random token before checkout, passes
 * it to Paddle as custom data, and polls for it afterwards. The webhook files
 * the key under the token's hash, and the success page picks it up.
 *
 * Persistence is one JSON file, rewritten atomically. The volume is one
 * write per purchase or subscription change, so a database would only add
 * operational weight.
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * `starter` and `pro` buy Jasb Search. `supporter` is the one-time lifetime
 * licence for people on their own keys: a thank-you, not an allowance.
 */
export type Plan = "starter" | "pro" | "supporter";

export interface License {
  plan: Plan;
  active: boolean;
  /** Paddle subscription id, for Starter and Pro. Supporter is a one-time purchase. */
  subscriptionId?: string;
  createdAt: number;
}

interface Claim {
  key: string;
  plan: Plan;
  expiresAt: number;
}

interface State {
  /** sha256(key) → licence */
  licenses: Record<string, License>;
  /** sha256(claim token) → the key waiting to be picked up */
  claims: Record<string, Claim>;
  /** Paddle transaction ids already handled. Webhooks are retried and can repeat. */
  seenTransactions: string[];
}

/** Long enough to finish checkout, reload the page, and come back later. */
const CLAIM_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SEEN_TRANSACTIONS = 5_000;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/** `jasb-xxxxx-xxxxx-xxxxx-xxxxx`: about 99 bits, readable aloud, no 0/o or 1/l. */
export function mintKey(): string {
  const bytes = randomBytes(20);
  const chars = Array.from(bytes, (byte) => ALPHABET[byte % ALPHABET.length]).join("");
  return `jasb-${chars.slice(0, 5)}-${chars.slice(5, 10)}-${chars.slice(10, 15)}-${chars.slice(15, 20)}`;
}

export class LicenseStore {
  #path: string | undefined;
  #state: State;
  #now: () => number;

  /** With no path the store is memory-only, which is what the tests use. */
  constructor(options: { path?: string; now?: () => number } = {}) {
    this.#path = options.path;
    this.#now = options.now ?? (() => Date.now());
    this.#state = this.#load();
    this.#expireClaims();
  }

  lookup(key: string | undefined): License | undefined {
    if (!key) return undefined;
    return this.#state.licenses[sha256(key.trim().toLowerCase())];
  }

  /**
   * Records a completed purchase. Returns false when this transaction was
   * already handled, so a webhook retry is a no-op.
   */
  recordPurchase(args: {
    transactionId: string;
    plan: Plan;
    claimToken?: string;
    subscriptionId?: string;
  }): boolean {
    if (this.#state.seenTransactions.includes(args.transactionId)) return false;
    this.#expireClaims();

    // A renewal is another completed transaction on a subscription that
    // already has a key. Keep it active; do not mint a second one.
    const existing = args.subscriptionId ? this.#bySubscription(args.subscriptionId) : undefined;
    if (existing) {
      existing.active = true;
    } else {
      const key = mintKey();
      this.#state.licenses[sha256(key)] = {
        plan: args.plan,
        active: true,
        ...(args.subscriptionId ? { subscriptionId: args.subscriptionId } : {}),
        createdAt: this.#now(),
      };
      if (args.claimToken) {
        this.#state.claims[sha256(args.claimToken)] = {
          key,
          plan: args.plan,
          expiresAt: this.#now() + CLAIM_TTL_MS,
        };
      }
    }

    this.#state.seenTransactions.push(args.transactionId);
    if (this.#state.seenTransactions.length > MAX_SEEN_TRANSACTIONS) {
      this.#state.seenTransactions.splice(0, this.#state.seenTransactions.length - MAX_SEEN_TRANSACTIONS);
    }
    this.#save();
    return true;
  }

  /** Follows the subscription: active while Paddle says it is billable. */
  setSubscriptionActive(subscriptionId: string, active: boolean): boolean {
    const license = this.#bySubscription(subscriptionId);
    if (!license || license.active === active) return false;
    license.active = active;
    this.#save();
    return true;
  }

  /** The key for a claim token, or undefined while the webhook has not landed. */
  claim(token: string | undefined): { key: string; plan: Plan } | undefined {
    if (!token) return undefined;
    this.#expireClaims();
    const claim = this.#state.claims[sha256(token)];
    return claim ? { key: claim.key, plan: claim.plan } : undefined;
  }

  #bySubscription(subscriptionId: string): License | undefined {
    return Object.values(this.#state.licenses).find(
      (license) => license.subscriptionId === subscriptionId,
    );
  }

  #expireClaims() {
    const now = this.#now();
    let changed = false;
    for (const [hash, claim] of Object.entries(this.#state.claims)) {
      if (claim.expiresAt <= now) {
        delete this.#state.claims[hash];
        changed = true;
      }
    }
    if (changed) this.#save();
  }

  #load(): State {
    const empty: State = { licenses: {}, claims: {}, seenTransactions: [] };
    if (!this.#path) return empty;
    try {
      return { ...empty, ...(JSON.parse(readFileSync(this.#path, "utf8")) as Partial<State>) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty;
      // A corrupt file must stop the server rather than silently start empty
      // and revoke every paying customer.
      throw error;
    }
  }

  #save() {
    if (!this.#path) return;
    mkdirSync(dirname(this.#path), { recursive: true });
    const temp = `${this.#path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(this.#state), { mode: 0o600 });
    renameSync(temp, this.#path);
  }
}
