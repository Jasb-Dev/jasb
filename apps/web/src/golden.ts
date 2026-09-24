/**
 * The golden set.
 *
 * One hundred real English queries across the categories the roadmap names.
 * Two jobs: it is the Phase 0 blind-test corpus, and it is the CI regression
 * fixture — every client must produce the identical card list for these, or the
 * "one engine, many shells" promise is not true.
 *
 * Written the way people actually type: lowercase, no punctuation, sometimes
 * misspelled. A corpus of well-formed questions would flatter the ranker.
 */

export type GoldenCategory =
  | "navigational"
  | "research"
  | "shopping"
  | "recipe"
  | "code"
  | "news"
  | "local"
  | "reference";

export interface GoldenQuery {
  text: string;
  category: GoldenCategory;
  /** What a good result set looks like. Used when grading, not by the engine. */
  expectation?: string;
}

export const GOLDEN_SET: GoldenQuery[] = [
  // --- navigational: should mostly never reach a search API ----------------
  { text: "figma sign in", category: "navigational", expectation: "figma.com login" },
  { text: "irs login", category: "navigational" },
  { text: "npm docs", category: "navigational" },
  { text: "cloudflare dashboard", category: "navigational" },
  { text: "stripe pricing", category: "navigational" },
  { text: "github status", category: "navigational" },
  { text: "notion", category: "navigational" },
  { text: "aws console", category: "navigational" },
  { text: "linear app", category: "navigational" },
  { text: "usps tracking", category: "navigational" },
  { text: "spotify web player", category: "navigational" },
  { text: "postgres documentation", category: "navigational" },

  // --- code ----------------------------------------------------------------
  { text: "typeerror cannot read properties of undefined reading map", category: "code" },
  { text: "rust borrow checker cannot borrow as mutable more than once", category: "code" },
  { text: "python asyncio gather vs task group", category: "code" },
  { text: "postgres explain analyze seq scan slow", category: "code" },
  { text: "docker compose healthcheck depends_on condition", category: "code" },
  { text: "git undo last commit but keep changes", category: "code" },
  { text: "css grid auto fill vs auto fit", category: "code" },
  { text: "npm err eresolve unable to resolve dependency tree", category: "code" },
  { text: "sqlite wal mode concurrent writes", category: "code" },
  { text: "typescript satisfies operator vs as const", category: "code" },
  { text: "nginx 502 bad gateway upstream timed out", category: "code" },
  { text: "react useeffect cleanup runs twice strict mode", category: "code" },
  { text: "how to read a parquet file in pandas", category: "code" },
  { text: "ffmpeg trim video without reencoding", category: "code" },

  // --- research ------------------------------------------------------------
  { text: "how do tardigrades survive vacuum", category: "research" },
  { text: "why did the roman republic fall", category: "research" },
  { text: "difference between weather and climate models", category: "research" },
  { text: "how do noise cancelling headphones work", category: "research" },
  { text: "what causes the northern lights", category: "research" },
  { text: "history of the shipping container", category: "research" },
  { text: "how does a heat pump work in cold weather", category: "research" },
  { text: "why is the sky blue but sunsets red", category: "research" },
  { text: "how do vaccines get approved", category: "research" },
  { text: "what is the replication crisis in psychology", category: "research" },
  { text: "how does gps correct for relativity", category: "research" },
  { text: "why do cities have heat islands", category: "research" },
  { text: "origin of the qwerty keyboard layout", category: "research" },
  { text: "how does compound interest actually work", category: "research" },

  // --- shopping ------------------------------------------------------------
  { text: "best mechanical keyboard under 100", category: "shopping" },
  { text: "cheap flights berlin to lisbon", category: "shopping" },
  { text: "mirrorless camera for beginners 2026", category: "shopping" },
  { text: "framework laptop vs thinkpad x1", category: "shopping" },
  { text: "most durable running shoes for flat feet", category: "shopping" },
  { text: "standing desk under 400 dollars", category: "shopping" },
  { text: "best noise cancelling headphones for flights", category: "shopping" },
  { text: "e ink tablet for reading pdfs", category: "shopping" },
  { text: "espresso machine for a small kitchen", category: "shopping" },
  { text: "cheapest way to ship a bike internationally", category: "shopping" },

  // --- recipe --------------------------------------------------------------
  { text: "kofte recipe", category: "recipe" },
  { text: "no knead sourdough bread", category: "recipe" },
  { text: "how to make pad thai at home", category: "recipe" },
  { text: "one pan chicken thighs weeknight", category: "recipe" },
  { text: "vegan mushroom ragu", category: "recipe" },
  { text: "how long to boil an egg soft yolk", category: "recipe" },
  { text: "tahini cookies", category: "recipe" },
  { text: "what to do with leftover rice", category: "recipe" },
  { text: "authentic carbonara no cream", category: "recipe" },
  { text: "gluten free pizza dough that actually works", category: "recipe" },

  // --- news ----------------------------------------------------------------
  { text: "eu ai act enforcement timeline", category: "news" },
  { text: "latest on semiconductor export controls", category: "news" },
  { text: "who won the champions league", category: "news" },
  { text: "interest rate decision this week", category: "news" },
  { text: "spacex launch schedule", category: "news" },
  { text: "wildfire smoke map today", category: "news" },
  { text: "recent chrome security update", category: "news" },
  { text: "openai news", category: "news" },

  // --- local ---------------------------------------------------------------
  { text: "coffee near me open now", category: "local" },
  { text: "dentist that takes walk ins", category: "local" },
  { text: "bike repair shop berlin kreuzberg", category: "local" },
  { text: "24 hour pharmacy istanbul", category: "local" },
  { text: "library with study rooms", category: "local" },
  { text: "vegetarian restaurants lisbon", category: "local" },
  { text: "post office saturday hours", category: "local" },
  { text: "laundromat with wifi", category: "local" },

  // --- reference -----------------------------------------------------------
  { text: "how many ounces in a liter", category: "reference" },
  { text: "utc to pacific time", category: "reference" },
  { text: "atomic number of tungsten", category: "reference" },
  { text: "what does gdpr article 17 say", category: "reference" },
  { text: "iso 8601 date format", category: "reference" },
  { text: "http status code 418", category: "reference" },
  { text: "population of estonia", category: "reference" },
  { text: "regex for email validation", category: "reference" },
  { text: "define ossify", category: "reference" },
  { text: "keyboard shortcut for em dash on mac", category: "reference" },
  { text: "how many weeks in a fiscal quarter", category: "reference" },
  { text: "bmi formula metric", category: "reference" },

  // --- awkward ones that should still work ---------------------------------
  { text: "tardigrde", category: "research", expectation: "misspelling still resolves" },
  { text: "that thing where your foot falls asleep", category: "reference" },
  { text: "why is my wifi slow only at night", category: "research" },
  { text: "is it safe to eat rice left out overnight", category: "reference" },
  { text: "how to cancel a subscription i forgot about", category: "reference" },
  { text: "book where the narrator is unreliable", category: "research" },
  { text: "song that goes da da da dum", category: "research" },
  { text: "apple.com vs samsung.com", category: "shopping", expectation: "not a URL — must search" },
  { text: "node.js vs deno performance", category: "code", expectation: "not a URL — must search" },
  { text: "what is 15 percent of 240", category: "reference" },
];

export const GOLDEN_BY_CATEGORY: Record<GoldenCategory, GoldenQuery[]> = GOLDEN_SET.reduce(
  (acc, query) => {
    (acc[query.category] ??= []).push(query);
    return acc;
  },
  {} as Record<GoldenCategory, GoldenQuery[]>,
);
