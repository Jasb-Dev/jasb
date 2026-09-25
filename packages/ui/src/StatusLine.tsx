import type { ResolveResult } from "@jasb/intent-engine";

/**
 * The status line.
 *
 * A product whose claim is "we do less, and we tell you what we did" has to
 * show its work: which intent was inferred, whether this came from cache, and
 * how long it took. It is also the honest place to admit low confidence —
 * calibrated probabilities are only worth having if the UI acts on them.
 */
export function StatusLine({
  result,
  quotaRemaining,
  onOpenAll,
}: {
  result: Extract<ResolveResult, { kind: "cards" }>;
  quotaRemaining?: number;
  /** Opens every card in a background tab, for research sessions. */
  onOpenAll?(): void;
}) {
  return (
    <div className="status" role="status">
      <span className="status__item">
        <span className={`status__dot${result.cached ? " status__dot--cached" : ""}`} />
        <span className="status__strong">{result.cards.length} sites</span>
      </span>

      <span className="status__item">{result.intent}</span>
      {result.lens !== "general" && <span className="status__item">{result.lens}</span>}

      <span className="status__item">
        {result.cached ? "from cache" : `${Math.round(result.tookMs)} ms`}
      </span>

      {result.lowConfidence && (
        <span className="status__item" style={{ color: "var(--warn)" }}>
          low confidence — showing fewer, try a more specific phrase
        </span>
      )}

      {quotaRemaining !== undefined && quotaRemaining >= 0 && (
        <span className="status__item" style={{ marginInlineStart: "auto" }}>
          {quotaRemaining} searches left this month
        </span>
      )}

      {onOpenAll && result.cards.length > 1 && (
        <button
          type="button"
          className="status__action"
          style={quotaRemaining !== undefined && quotaRemaining >= 0 ? undefined : { marginInlineStart: "auto" }}
          onClick={onOpenAll}
          title="Open every result in a background tab (⌘/Ctrl-click or middle-click opens one)"
        >
          Open all {result.cards.length} in tabs
        </button>
      )}
    </div>
  );
}

/** Errors and quota walls. States the problem and the way out — no apologies. */
export function Notice({
  title,
  body,
  actionLabel,
  onAction,
}: {
  title: string;
  body: string;
  actionLabel?: string;
  onAction?(): void;
}) {
  return (
    <div className="notice" role="alert">
      <span className="notice__title">{title}</span>
      <span className="notice__body">{body}</span>
      {actionLabel && onAction && (
        <button type="button" className="notice__action" onClick={onAction}>
          {actionLabel}
        </button>
      )}
    </div>
  );
}
