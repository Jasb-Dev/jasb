import { useEffect, useState } from "react";
import { Icon } from "@jasb/ui";

/**
 * The Fire button's confirmation. One step, inline, with the exact list of
 * what goes and what stays: "clear browsing data" is only trustworthy when
 * nobody has to guess what it means.
 */
export function FirePanel({ onClose, onBurned }: { onClose(): void; onBurned(): void }) {
  const [burning, setBurning] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="panel-scrim" onMouseDown={onClose}>
      <section
        className="fire-panel"
        role="dialog"
        aria-label="Clear browsing data"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <span className="fire-panel__icon" aria-hidden="true">
          <Icon name="flame" size={26} />
        </span>
        <h2 className="fire-panel__title">Close all tabs and clear browsing data?</h2>
        <div className="fire-panel__lists">
          <div>
            <span className="label">Goes</span>
            <ul>
              <li>Every open tab</li>
              <li>Cookies and site data, so you are signed out</li>
              <li>Cached pages and images</li>
              <li>Search history and cached results</li>
              <li>Page measurements (trackers, load times)</li>
            </ul>
          </div>
          <div>
            <span className="label">Stays</span>
            <ul>
              <li>Your provider keys and licence</li>
              <li>Pinned and blocked sites</li>
              <li>Settings</li>
            </ul>
          </div>
        </div>
        <div className="fire-panel__actions">
          <button type="button" className="fire-panel__cancel" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="fire-panel__burn"
            disabled={burning}
            onClick={async () => {
              setBurning(true);
              await window.jasb.burn();
              onBurned();
            }}
          >
            <Icon name="flame" size={15} />
            {burning ? "Clearing…" : "Clear everything above"}
          </button>
        </div>
      </section>
    </div>
  );
}
