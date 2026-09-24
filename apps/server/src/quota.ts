/**
 * Anonymous quota.
 *
 * The server must limit abuse without learning who anyone is. The client
 * generates a random device token once and sends it as a header; we keep only
 * a hash of it and a counter, in memory, reset daily. No IP, no account, no
 * query text.
 *
 * This is the placeholder for the Privacy Pass design in the roadmap: swapping
 * the counter for blinded tokens changes this file and nothing else, because
 * the rest of the server only ever asks "may this request proceed?".
 */

import { hashQuery } from "@jasb/intent-engine";

export interface QuotaDecision {
  allowed: boolean;
  remaining: number;
  limit: number;
  /** Seconds until the counter resets. */
  resetInSeconds: number;
}

interface Bucket {
  count: number;
  /** Day index (UTC) the count belongs to. */
  day: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export class QuotaTracker {
  #buckets = new Map<string, Bucket>();
  #limit: number;
  #now: () => number;
  #maxBuckets: number;

  constructor(options: { limit: number; now?: () => number; maxBuckets?: number }) {
    this.#limit = options.limit;
    this.#now = options.now ?? (() => Date.now());
    // Bounded so a flood of fresh tokens cannot exhaust memory. Eviction is
    // FIFO: the oldest token simply gets a fresh allowance, which is the
    // failure mode we want — generous to users, still bounded for us.
    this.#maxBuckets = options.maxBuckets ?? 50_000;
  }

  /** Checks and consumes one unit. Returns the decision either way. */
  consume(deviceToken: string, cost = 1): QuotaDecision {
    const now = this.#now();
    const day = Math.floor(now / DAY_MS);
    const key = hashQuery(deviceToken);

    let bucket = this.#buckets.get(key);
    if (!bucket || bucket.day !== day) {
      bucket = { count: 0, day };
    }

    const resetInSeconds = Math.ceil(((day + 1) * DAY_MS - now) / 1000);

    if (bucket.count + cost > this.#limit) {
      this.#store(key, bucket);
      return { allowed: false, remaining: 0, limit: this.#limit, resetInSeconds };
    }

    bucket.count += cost;
    this.#store(key, bucket);
    return {
      allowed: true,
      remaining: Math.max(0, this.#limit - bucket.count),
      limit: this.#limit,
      resetInSeconds,
    };
  }

  /** Reads the current state without consuming. */
  peek(deviceToken: string): QuotaDecision {
    const now = this.#now();
    const day = Math.floor(now / DAY_MS);
    const bucket = this.#buckets.get(hashQuery(deviceToken));
    const count = bucket && bucket.day === day ? bucket.count : 0;
    return {
      allowed: count < this.#limit,
      remaining: Math.max(0, this.#limit - count),
      limit: this.#limit,
      resetInSeconds: Math.ceil(((day + 1) * DAY_MS - now) / 1000),
    };
  }

  #store(key: string, bucket: Bucket): void {
    this.#buckets.delete(key);
    this.#buckets.set(key, bucket);
    while (this.#buckets.size > this.#maxBuckets) {
      const oldest = this.#buckets.keys().next();
      if (oldest.done) break;
      this.#buckets.delete(oldest.value);
    }
  }
}

/**
 * Counts distinct devices per query so the shared cache only stores entries
 * that at least `k` people have asked for.
 *
 * A search only one person ever makes may identify them; it never reaches the
 * shared cache. We store hashes, never the query text or the device token.
 */
export class KAnonymityGate {
  #seen = new Map<string, Set<string>>();
  #k: number;
  #maxQueries: number;

  constructor(k: number, maxQueries = 20_000) {
    this.#k = k;
    this.#maxQueries = maxQueries;
  }

  /** Records this device's interest and reports whether the query may be shared. */
  observe(queryHash: string, deviceToken: string): boolean {
    let devices = this.#seen.get(queryHash);
    if (!devices) {
      devices = new Set();
      this.#seen.set(queryHash, devices);
    }
    devices.add(hashQuery(deviceToken));

    while (this.#seen.size > this.#maxQueries) {
      const oldest = this.#seen.keys().next();
      if (oldest.done) break;
      this.#seen.delete(oldest.value);
    }

    return devices.size >= this.#k;
  }
}
