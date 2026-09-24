/**
 * The spend ceiling.
 *
 * A public "try it" box on a public domain is an open invitation to spend our
 * money. Per-device quota bounds one visitor; it does nothing about ten
 * thousand visitors, or one visitor with ten thousand fresh device tokens.
 *
 * So there is a second, global limit: a hard cap on billable resolutions per
 * day. When it is reached the demo degrades — free sources only, no paid search
 * API, no decision model — rather than going down or going over budget.
 *
 * "Degrade, don't fail" matters here. A visitor who hits the cap still sees
 * Wikipedia and small-web results and still understands the product; a visitor
 * who sees an error page concludes it is broken.
 */

export interface BudgetState {
  /** Billable resolutions used today. */
  used: number;
  limit: number;
  /** False once the cap is reached: callers should drop to free sources. */
  paidSourcesAllowed: boolean;
  resetInSeconds: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export class DailyBudget {
  #limit: number;
  #now: () => number;
  #day = -1;
  #used = 0;

  constructor(options: { limit: number; now?: () => number }) {
    this.#limit = options.limit;
    this.#now = options.now ?? (() => Date.now());
  }

  /** Current state without consuming anything. */
  peek(): BudgetState {
    this.#roll();
    return this.#state();
  }

  /**
   * Records one billable resolution.
   *
   * Called *after* the engine reports it actually reached a provider, so cache
   * hits, URLs and bangs never count — the same rule the per-device quota uses.
   */
  consume(cost = 1): BudgetState {
    this.#roll();
    this.#used += cost;
    return this.#state();
  }

  #roll(): void {
    const day = Math.floor(this.#now() / DAY_MS);
    if (day !== this.#day) {
      this.#day = day;
      this.#used = 0;
    }
  }

  #state(): BudgetState {
    return {
      used: this.#used,
      limit: this.#limit,
      paidSourcesAllowed: this.#used < this.#limit,
      resetInSeconds: Math.ceil(((this.#day + 1) * DAY_MS - this.#now()) / 1000),
    };
  }
}
