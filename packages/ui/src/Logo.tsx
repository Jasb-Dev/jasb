/**
 * The Jasb mark.
 *
 * The mark is a miniature of the product's own unit: a result card, with the
 * thin rule that separates a card's preview from its body, and a lowercase `j`
 * sitting across it. The tittle — the dot — lands in the preview area and is
 * the one place the signal colour appears, the same way it is the one accent in
 * the interface.
 *
 * It resolves at 16 px because it is three shapes: a rounded square, a dot, and
 * a stroke. The `compact` variant drops the rule, which is the first detail to
 * go muddy at favicon size.
 */

export interface LogoProps {
  /** Height of the mark in pixels. The wordmark scales with it. */
  size?: number;
  /** `mark` is the square alone; `full` adds the wordmark beside it. */
  variant?: "mark" | "full";
  /** Drops the interior rule. Use below ~20 px. */
  compact?: boolean;
  /** Adds the tagline under the wordmark. Ignored for `mark`. */
  tagline?: boolean;
  className?: string;
}

export function Logo({
  size = 28,
  variant = "full",
  compact = false,
  tagline = false,
  className,
}: LogoProps) {
  const mark = <LogoMark size={size} compact={compact} />;

  if (variant === "mark") {
    return <span className={className}>{mark}</span>;
  }

  return (
    <span className={`logo${className ? ` ${className}` : ""}`}>
      {mark}
      <span className="logo__text">
        <span className="logo__word" style={{ fontSize: size * 0.72 }}>
          jasb
        </span>
        {tagline && <span className="logo__tagline">just a browser</span>}
      </span>
    </span>
  );
}

export function LogoMark({ size = 28, compact = false }: { size?: number; compact?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      role="img"
      aria-label="Jasb"
      focusable="false"
      style={{ display: "block", flexShrink: 0 }}
    >
      {/* The card. Ink-filled, so the mark reads as a solid shape at any size. */}
      <rect x="3" y="3" width="26" height="26" rx="7.5" fill="var(--logo-ink, #141719)" />

      {/* The preview/body divider, straight out of the result card. */}
      {!compact && (
        <path
          d="M3.6 12.6h24.8"
          stroke="var(--logo-paper, #fbfbf8)"
          strokeOpacity="0.22"
          strokeWidth="1"
        />
      )}

      {/* The tittle — the only accent in the entire identity. */}
      <circle cx="16" cy="8.4" r={compact ? 2.7 : 2.3} fill="var(--logo-signal, #0b6b5b)" />

      {/* The stem and its hook: the letter, and the gesture of going somewhere. */}
      <path
        d="M16 15.4v5.1c0 2.6-2.1 3.8-4 3.1"
        stroke="var(--logo-paper, #fbfbf8)"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
    </svg>
  );
}
