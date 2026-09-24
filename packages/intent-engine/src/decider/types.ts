/**
 * The decision layer.
 *
 * Almost nothing the search pipeline asks a model to do is text generation —
 * it is selection and scoring. Jev and Laya are built for exactly that shape,
 * and a JSON-mode LLM can emulate it. One interface, three implementations.
 */

/** Pick one option from a labelled set. Mirrors Jev's `choice` primitive. */
export interface ChoiceQuestion<T extends string = string> {
  type: "choice";
  instructions: string;
  /** option key → what that option means. Up to 255 options. */
  criteria: Record<T, string>;
}

/** Rate against ordered levels. Mirrors Jev's `score` primitive (2–10 levels). */
export interface ScoreQuestion {
  type: "score";
  instructions: string;
  /** Ordered low → high, e.g. `["irrelevant", "tangential", "relevant", "exact"]`. */
  criteria: string[];
}

/** Calibrated yes/no probability. Mirrors Jev's `noul` primitive. */
export interface NoulQuestion {
  type: "noul";
  instructions: string;
}

export type Question = ChoiceQuestion | ScoreQuestion | NoulQuestion;

export interface ChoiceAnswer<T extends string = string> {
  type: "choice";
  value: T;
  /** option key → probability. Sums to ~1. */
  probabilities: Record<string, number>;
  confidence: number;
}

export interface ScoreAnswer {
  type: "score";
  /** Continuous position on the rubric, normalised to 0..1. */
  value: number;
  /** Nearest discrete level label. */
  level: string;
  confidence: number;
}

export interface NoulAnswer {
  type: "noul";
  /** Probability the statement is true. 0..1 */
  probability: number;
  confidence: number;
}

export type Answer = ChoiceAnswer | ScoreAnswer | NoulAnswer;

/**
 * `state` is the thing being judged (a query, a candidate, a page excerpt).
 * `questions` are asked against it in one round trip — that batching is the
 * whole point: 20 candidates × 2 questions is one call, not 40.
 */
export interface Decider {
  readonly name: string;

  choose<T extends string>(
    state: unknown,
    question: ChoiceQuestion<T>,
    signal?: AbortSignal,
  ): Promise<ChoiceAnswer<T>>;

  score(state: unknown, question: ScoreQuestion, signal?: AbortSignal): Promise<ScoreAnswer>;

  yesNo(state: unknown, question: NoulQuestion, signal?: AbortSignal): Promise<NoulAnswer>;

  /**
   * Ask several questions about one state in a single round trip.
   * Implementations that cannot batch may loop, but should say so in `name`.
   */
  ask(
    state: unknown,
    questions: Record<string, Question>,
    signal?: AbortSignal,
  ): Promise<Record<string, Answer>>;

  /** Cheap liveness probe used by the auto-fallback wrapper. */
  healthy?(): Promise<boolean>;
}

export class DeciderError extends Error {
  readonly decider: string;
  readonly detail: unknown;

  constructor(message: string, decider: string, detail?: unknown) {
    super(message);
    this.name = "DeciderError";
    this.decider = decider;
    this.detail = detail;
  }
}

/** Maps a discrete level index onto 0..1 so scorers are comparable across rubrics. */
export function levelToUnit(index: number, levelCount: number): number {
  if (levelCount <= 1) return 1;
  return index / (levelCount - 1);
}
