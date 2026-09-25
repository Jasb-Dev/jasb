import { useState } from "react";
import type { Card } from "@jasb/intent-engine";

import { IconButton } from "./IconButton.tsx";

/**
 * One result.
 *
 * Reads top to bottom as a catalogue entry: preview, what kind of page it is,
 * its title, where it lives, and how instrumented it is. The numbered badge is
 * the keyboard shortcut that opens it — numbering that carries real information
 * rather than decoration.
 */
export interface ResultCardProps {
  card: Card;
  /** 1-based position; doubles as the keyboard shortcut. */
  index: number;
  /**
   * Opens the card in a new tab. `background` is set for ⌘/Ctrl-click and
   * middle-click, so several results can be opened without leaving the grid.
   */
  onOpen(card: Card, options?: { background?: boolean }): void;
  onBlock(domain: string): void;
  onPin(domain: string): void;
}

export function ResultCard({ card, index, onOpen, onBlock, onPin }: ResultCardProps) {
  const [thumbFailed, setThumbFailed] = useState(false);
  const trackers = card.signals.trackers;

  return (
    <li
      className={`card rise${card.pinned ? " card--pinned" : ""}`}
      style={{ animationDelay: `${Math.min(index - 1, 7) * 24}ms` }}
    >
      <a
        className="card__link"
        href={card.url}
        onClick={(event) => {
          // Every client opens results in a new tab. The shell decides what a
          // tab is (a Jasb tab, a Chrome tab, a browser window); the card only
          // says whether the user wants to stay on the grid.
          if (event.button !== 0) return;
          event.preventDefault();
          onOpen(card, event.metaKey || event.ctrlKey ? { background: true } : undefined);
        }}
        onAuxClick={(event) => {
          if (event.button !== 1) return;
          event.preventDefault();
          onOpen(card, { background: true });
        }}
      >
        <div className="card__preview">
          <span className="card__key" aria-hidden="true">
            {index}
          </span>

          {(card.pinned || card.origin === "bookmark" || card.origin === "history") && (
            <span className="card__badges">
              {card.origin === "bookmark" && <span className="badge">Bookmarked</span>}
              {card.origin === "history" && <span className="badge">Visited</span>}
              {card.pinned && <span className="badge badge--signal">Pinned</span>}
            </span>
          )}

          {card.thumbnailUrl && !thumbFailed ? (
            <img
              className="card__thumb"
              src={card.thumbnailUrl}
              alt=""
              loading="lazy"
              decoding="async"
              // A dead og:image is common. Fall through to the domain plate
              // rather than leaving an empty rectangle in the grid.
              onError={() => setThumbFailed(true)}
            />
          ) : (
            <div className="card__fallback" aria-hidden="true">
              {card.domain}
            </div>
          )}
        </div>

        <div className="card__body">
          <span className="card__reason">{card.reason}</span>
          <h3 className="card__title">{card.title}</h3>
          <span className="card__domain">
            {card.faviconUrl && (
              <img
                className="card__favicon"
                src={card.faviconUrl}
                alt=""
                loading="lazy"
                decoding="async"
                onError={(event) => {
                  event.currentTarget.style.visibility = "hidden";
                }}
              />
            )}
            <span className="card__domain-text">{card.domain}</span>
          </span>
        </div>
      </a>

      <QualityStrip trackers={trackers} loadMs={card.signals.loadMs} paywall={card.signals.paywall} />

      <div className="card__tools">
        <IconButton
          icon={card.pinned ? "pin-filled" : "pin"}
          label={card.pinned ? "Unpin" : "Pin"}
          pressed={card.pinned ?? false}
          title={
            card.pinned
              ? `Stop ranking ${card.domain} first`
              : `Always rank ${card.domain} first`
          }
          onClick={() => onPin(card.domain)}
        />
        <IconButton
          icon="block"
          label="Block"
          title={`Never show ${card.domain} again`}
          onClick={() => onBlock(card.domain)}
        />
      </div>
    </li>
  );
}

/**
 * The quality strip.
 *
 * Tracker load as ticks, because "3" and "19" look alike in a glance but three
 * lit ticks and a full row do not. Ticks are capped at eight: past that the
 * exact number stops mattering.
 */
export function QualityStrip({
  trackers,
  loadMs,
  paywall,
}: {
  trackers?: number;
  loadMs?: number;
  paywall?: boolean;
}) {
  if (trackers === undefined && loadMs === undefined && !paywall) {
    return <div className="strip" aria-hidden="true" />;
  }

  const ticks = trackers === undefined ? 0 : Math.min(8, Math.ceil(trackers / 3));
  const clean = trackers === 0;

  return (
    <div className="strip">
      {trackers !== undefined && (
        <>
          <span className="strip__ticks" aria-hidden="true">
            {Array.from({ length: 8 }, (_, i) => (
              <span
                key={i}
                className={
                  clean && i === 0
                    ? "strip__tick strip__tick--clean"
                    : i < ticks
                      ? "strip__tick strip__tick--on"
                      : "strip__tick"
                }
              />
            ))}
          </span>
          <span className="strip__text">
            {clean ? "no trackers" : `${trackers} tracker${trackers === 1 ? "" : "s"}`}
          </span>
        </>
      )}

      {loadMs !== undefined && <span className="strip__text">{Math.round(loadMs)} ms</span>}
      {paywall && <span className="badge badge--warn">Paywall</span>}
    </div>
  );
}

/** Placeholder card. Identical box model to a real one, so nothing shifts. */
export function SkeletonCard({ index }: { index: number }) {
  return (
    <li className="skeleton" aria-hidden="true">
      <div className="skeleton__preview skeleton__pulse" style={{ animationDelay: `${index * 90}ms` }} />
      <div className="skeleton__body">
        <div className="skeleton__line skeleton__line--short skeleton__pulse" />
        <div className="skeleton__line skeleton__pulse" />
        <div className="skeleton__line skeleton__line--medium skeleton__pulse" />
      </div>
    </li>
  );
}
