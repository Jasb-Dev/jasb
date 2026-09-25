/**
 * Anonymous quota.
 *
 * The server must limit abuse without learning who anyone is. The client
 * generates a random device token once and sends it as a header; we keep only
 * a hash of it and a counter, reset daily or monthly depending on the plan.
 * No IP, no account, no query text.
 *
 * This is the placeholder for the Privacy Pass design in the roadmap: swapping
 * the counter for blinded tokens changes this file and nothing else, because
 * the rest of the server only ever asks "may this request proceed?".
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { hashQuery } from "@jasb/intent-engine";

export interface QuotaDecision {
  allowed: boolean;
  remaining: number;
  limit: number;
  /** Seconds until the counter resets. */
  resetInSeconds: number;
}

export type QuotaPeriod = "day" | "month";

interface Bucket {
  count: number;
  /** Index (UTC) of the day or month the count belongs to. */
  period: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The period index `now` falls in, and when that period ends. */
function periodOf(period: QuotaPeriod, now: number): { index: number; endsAt: number } {
  if (period === "day") {
    const index = Math.floor(now / DAY_MS);
    return { index, endsAt: (index + 1) * DAY_MS };
  }
  const date = new Date(now);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  return { index: year * 12 + month, endsAt: Date.UTC(year, month + 1, 1) };
}

export class QuotaTracker {
  #buckets = new Map<string, Bucket>();
  #limit: number;
  #period: QuotaPeriod;
  #now: () => number;
  #maxBuckets: number;
  #path: string | undefined;
  #dirty = false;

  constructor(options: {
    limit: number;
    /** Daily for the demo, monthly for the plans. Defaults to daily. */
    period?: QuotaPeriod;
    now?: () => number;
    maxBuckets?: number;
    /**
     * Where to keep the counters between restarts. A monthly allowance that
     * reset on every deploy would not be an allowance. Only hashed device
     * tokens and numbers are written; nothing else is known to store.
     */
    path?: string;
  }) {
    this.#limit = options.limit;
    this.#period = options.period ?? "day";
    this.#now = options.now ?? (() => Date.now());
    // Bounded so a flood of fresh tokens cannot exhaust memory. Eviction is
    // FIFO: the oldest token simply gets a fresh allowance, which is the
    // failure mode we want — generous to users, still bounded for us.
    this.#maxBuckets = options.maxBuckets ?? 50_000;
    this.#path = options.path;
    this.#load();
  }

  /** Checks and consumes one unit. Returns the decision either way. */
  consume(deviceToken: string, cost = 1): QuotaDecision {
    const now = this.#now();
    const { index, endsAt } = periodOf(this.#period, now);
    const key = hashQuery(deviceToken);

    let bucket = this.#buckets.get(key);
    if (!bucket || bucket.period !== index) {
      bucket = { count: 0, period: index };
    }

    const resetInSeconds = Math.ceil((endsAt - now) / 1000);

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
    const { index, endsAt } = periodOf(this.#period, now);
    const bucket = this.#buckets.get(hashQuery(deviceToken));
    const count = bucket && bucket.period === index ? bucket.count : 0;
    return {
      allowed: count < this.#limit,
      remaining: Math.max(0, this.#limit - count),
      limit: this.#limit,
      resetInSeconds: Math.ceil((endsAt - now) / 1000),
    };
  }

  get period(): QuotaPeriod {
    return this.#period;
  }

  /** Writes the counters to disk if anything changed. Cheap to call often. */
  flush(): void {
    if (!this.#path || !this.#dirty) return;
    const { index } = periodOf(this.#period, this.#now());
    // Past periods are dead weight; only the current one is worth keeping.
    const live = [...this.#buckets].filter(([, bucket]) => bucket.period === index);
    mkdirSync(dirname(this.#path), { recursive: true });
    const temp = `${this.#path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(live), { mode: 0o600 });
    renameSync(temp, this.#path);
    this.#dirty = false;
  }

  #load(): void {
    if (!this.#path) return;
    try {
      const entries = JSON.parse(readFileSync(this.#path, "utf8")) as [string, Bucket][];
      for (const [key, bucket] of entries) {
        if (typeof bucket?.count === "number" && typeof bucket.period === "number") {
          this.#buckets.set(key, bucket);
        }
      }
    } catch {
      // Missing or unreadable: start fresh. Being generous for one period is
      // the failure mode we can live with, unlike the licence store.
    }
  }

  #store(key: string, bucket: Bucket): void {
    this.#buckets.delete(key);
    this.#buckets.set(key, bucket);
    this.#dirty = true;
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
