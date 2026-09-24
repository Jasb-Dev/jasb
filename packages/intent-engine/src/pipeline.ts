/**
 * The decision steps of the pipeline.
 *
 * Every one of these is a *selection*, not a generation — which is why the
 * whole thing runs on Jev-style primitives and costs a fraction of a cent.
 * The only thing a language model would traditionally write here is the "why
 * this site" line, and we replaced that with a fixed label set.
 */

import type { Decider } from "./decider/types.ts";
import type { ChoiceQuestion, NoulQuestion, ScoreQuestion } from "./decider/types.ts";
import {
  INTENT_TYPES,
  LENSES,
  REASON_LABELS,
  type Candidate,
  type IntentType,
  type Lens,
  type ReasonLabel,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Step: intent + lens
// ---------------------------------------------------------------------------

const INTENT_CRITERIA: Record<IntentType, string> = {
  navigational: "The user wants one specific site they already have in mind.",
  research: "The user wants to understand a topic and will read several sources.",
  shopping: "The user wants to buy something or compare prices and products.",
  recipe: "The user wants cooking instructions for a dish.",
  code: "The user is programming: an error message, an API, a library, a how-to.",
  news: "The user wants recent events; freshness matters more than depth.",
  local: "The user wants a place, business, or service near a physical location.",
  reference: "The user wants a single fact, definition, date, or conversion.",
};

const LENS_CRITERIA: Record<Lens, string> = {
  general: "No particular source type fits better than the open web.",
  programming: "Official docs, source repositories and package registries.",
  forums: "Discussion threads where practitioners answer each other.",
  academic: "Papers, preprints, and scholarly sources.",
  docs: "Vendor documentation and reference manuals.",
  recipes: "Cooking sites, preferring ones without life-story preambles.",
  news: "News outlets and wire services.",
  shopping: "Retailers, price comparison, and independent product reviews.",
  smallweb: "Personal sites, blogs, and non-commercial independent pages.",
};

/** Sensible lens when the decider is unavailable — keeps the engine working offline. */
const LENS_BY_INTENT: Record<IntentType, Lens> = {
  navigational: "general",
  research: "general",
  shopping: "shopping",
  recipe: "recipes",
  code: "programming",
  news: "news",
  local: "general",
  reference: "general",
};

export interface IntentPlan {
  intent: IntentType;
  lens: Lens;
  confidence: number;
}

/**
 * Intent and lens in one round trip.
 *
 * Batching matters: asking both questions separately doubles the latency of the
 * step that gates everything downstream.
 */
export async function planIntent(
  query: string,
  decider: Decider,
  signal?: AbortSignal,
): Promise<IntentPlan> {
  const intentQuestion: ChoiceQuestion<IntentType> = {
    type: "choice",
    instructions: "What kind of thing is this person looking for?",
    criteria: INTENT_CRITERIA,
  };
  const lensQuestion: ChoiceQuestion<Lens> = {
    type: "choice",
    instructions: "Which kinds of sources will best satisfy this search?",
    criteria: LENS_CRITERIA,
  };

  const answers = await decider.ask(
    { query },
    { intent: intentQuestion, lens: lensQuestion },
    signal,
  );

  const intentAnswer = answers.intent;
  const lensAnswer = answers.lens;

  const intent =
    intentAnswer?.type === "choice" && isIntent(intentAnswer.value)
      ? intentAnswer.value
      : "research";
  const lens =
    lensAnswer?.type === "choice" && isLens(lensAnswer.value)
      ? lensAnswer.value
      : LENS_BY_INTENT[intent];

  const confidence = Math.min(
    intentAnswer?.type === "choice" ? intentAnswer.confidence : 0.5,
    lensAnswer?.type === "choice" ? lensAnswer.confidence : 0.5,
  );

  return { intent, lens, confidence };
}

/** Keyword fallback for when no decider is reachable at all. */
export function guessIntent(query: string): IntentPlan {
  const q = query.toLowerCase();
  const rules: [RegExp, IntentType][] = [
    [/\b(recipe|how to (?:cook|bake|make)|ingredients)\b/, "recipe"],
    [/\b(error|exception|typeerror|undefined|npm|pip|compile|segfault|stack ?trace)\b/, "code"],
    [/\b(buy|price|cheap|deal|discount|vs\.?|best .* for)\b/, "shopping"],
    [/\b(news|today|breaking|latest|announced)\b/, "news"],
    [/\b(near me|nearby|open now|directions to|address of)\b/, "local"],
    [/\b(what is|who is|when did|define|meaning of|convert)\b/, "reference"],
    [/\b(login|sign in|dashboard|homepage)\b/, "navigational"],
  ];

  for (const [pattern, intent] of rules) {
    if (pattern.test(q)) {
      return { intent, lens: LENS_BY_INTENT[intent], confidence: 0.55 };
    }
  }
  return { intent: "research", lens: "general", confidence: 0.4 };
}

// ---------------------------------------------------------------------------
// Step: rerank
// ---------------------------------------------------------------------------

const RELEVANCE_LEVELS = ["irrelevant", "tangential", "related", "relevant", "exactly what was asked"];

export interface RerankJudgement {
  relevance: number;
  spamProbability: number;
  confidence: number;
  reason: ReasonLabel;
}

/**
 * Judges one candidate: how relevant, how likely to be SEO spam, and which
 * fixed label describes it.
 *
 * All three questions ride in a single call, and the caller fans these out
 * across candidates in parallel — that is what makes per-query spam checking on
 * all 20 candidates affordable, which is the thing plain LLM reranking could
 * never do at this price point.
 */
export async function judgeCandidate(
  query: string,
  intent: IntentType,
  candidate: Candidate,
  decider: Decider,
  signal?: AbortSignal,
): Promise<RerankJudgement> {
  const relevanceQuestion: ScoreQuestion = {
    type: "score",
    instructions: `How well does this page satisfy the search "${query}"?`,
    criteria: RELEVANCE_LEVELS,
  };
  const spamQuestion: NoulQuestion = {
    type: "noul",
    instructions:
      "Is this a content farm, an AI-generated filler page, or an SEO page whose " +
      "real purpose is affiliate revenue rather than answering the question?",
  };
  const reasonQuestion: ChoiceQuestion<ReasonLabel> = {
    type: "choice",
    instructions: "Which single label best describes what this page is?",
    criteria: reasonCriteria(),
  };

  const answers = await decider.ask(
    {
      query,
      intent,
      page: {
        title: candidate.title,
        domain: candidate.domain,
        url: candidate.url,
        snippet: candidate.snippet.slice(0, 400),
      },
    },
    { relevance: relevanceQuestion, spam: spamQuestion, reason: reasonQuestion },
    signal,
  );

  const relevanceAnswer = answers.relevance;
  const spamAnswer = answers.spam;
  const reasonAnswer = answers.reason;

  return {
    relevance: relevanceAnswer?.type === "score" ? relevanceAnswer.value : 0.5,
    spamProbability: spamAnswer?.type === "noul" ? spamAnswer.probability : 0.2,
    confidence: relevanceAnswer?.type === "score" ? relevanceAnswer.confidence : 0.4,
    reason:
      reasonAnswer?.type === "choice" && isReasonLabel(reasonAnswer.value)
        ? reasonAnswer.value
        : fallbackReason(candidate, intent),
  };
}

let reasonCriteriaCache: Record<ReasonLabel, string> | undefined;

/** The label set, described for the decider. Built once — it never changes. */
function reasonCriteria(): Record<ReasonLabel, string> {
  reasonCriteriaCache ??= Object.fromEntries(
    REASON_LABELS.map((label) => [label, describeLabel(label)]),
  ) as Record<ReasonLabel, string>;
  return reasonCriteriaCache;
}

function describeLabel(label: ReasonLabel): string {
  switch (label) {
    case "Official site":
      return "The homepage or product page of the organisation being asked about.";
    case "Official docs":
      return "First-party documentation maintained by the project or vendor.";
    case "Source repository":
      return "A code repository such as GitHub, GitLab or Codeberg.";
    case "Forum discussion":
      return "A thread where people discuss the topic, such as Reddit or a mailing list.";
    case "Q&A thread":
      return "A question with answers, such as Stack Overflow.";
    case "Ad-free recipe":
      return "A recipe page that gets straight to ingredients and method.";
    case "Independent review":
      return "A hands-on review not written by the seller.";
    case "Small-web find":
      return "A personal or non-commercial page from the independent web.";
    case "Personal blog":
      return "One person writing in their own voice on their own site.";
    default:
      return label;
  }
}

/** Structural guess when the decider did not return a usable label. */
export function fallbackReason(candidate: Candidate, intent: IntentType): ReasonLabel {
  const { domain, url } = candidate;

  if (/(^|\.)wikipedia\.org$/.test(domain)) return "Encyclopedia entry";
  if (/(^|\.)(github|gitlab|codeberg|sr\.ht)\.(com|org|ht)$/.test(domain)) {
    return /\/issues?\//.test(url) ? "Issue tracker" : "Source repository";
  }
  if (/(^|\.)stackoverflow\.com$/.test(domain) || /stackexchange\.com$/.test(domain)) {
    return "Q&A thread";
  }
  if (/(^|\.)(reddit|news\.ycombinator|lobste)\.(com|rs)$/.test(domain)) {
    return "Forum discussion";
  }
  if (/(^|\.)(npmjs|pypi|crates|rubygems|packagist)\.(com|org|io)$/.test(domain)) {
    return "Package page";
  }
  if (/(^|\.)arxiv\.org$/.test(domain)) return "Preprint archive";
  if (/\.(gov|mil)$/.test(domain) || /\.gov\.[a-z]{2}$/.test(domain)) {
    return "Government resource";
  }
  if (/(^|\.)(youtube|vimeo)\.com$/.test(domain)) return "Video walkthrough";
  if (/^docs?\./.test(domain) || /\/docs?\//.test(url)) return "Official docs";

  switch (intent) {
    case "recipe":
      return "Recipe collection";
    case "news":
      return "News report";
    case "shopping":
      return "Retailer page";
    case "code":
      return "Official docs";
    case "local":
      return "Local listing";
    case "reference":
      return "Reference table";
    default:
      return "In-depth guide";
  }
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

function isIntent(value: string): value is IntentType {
  return (INTENT_TYPES as readonly string[]).includes(value);
}

function isLens(value: string): value is Lens {
  return (LENSES as readonly string[]).includes(value);
}

function isReasonLabel(value: string): value is ReasonLabel {
  return (REASON_LABELS as readonly string[]).includes(value);
}
