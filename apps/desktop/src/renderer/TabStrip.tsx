import type { TabState } from "../shared/ipc.ts";

/**
 * The tab strip.
 *
 * Minimal by design, and it carries one thing no other browser's tab strip
 * does: the live third-party request count for the page in front of you. That
 * number is measured, not looked up, and it is the same signal that quietly
 * ranks results in the grid — so the instrument is visible rather than hidden
 * in a settings pane nobody opens.
 */
export function TabStrip({
  tabs,
  activeTabId,
  showingCards,
  onSelect,
  onClose,
  onNew,
  onShowCards,
}: {
  tabs: TabState[];
  activeTabId: number | undefined;
  showingCards: boolean;
  onSelect(id: number): void;
  onClose(id: number): void;
  onNew(): void;
  onShowCards(): void;
}) {
  return (
    <div className="tabs">
      {/* Space for the traffic lights on macOS, where the title bar is hidden. */}
      <span className="tabs__gutter" />

      <button
        type="button"
        className="tabs__home"
        aria-pressed={showingCards}
        onClick={onShowCards}
        title="Back to results (Esc)"
      >
        Results
      </button>

      <div className="tabs__list scroll-x">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`tab${!showingCards && tab.id === activeTabId ? " tab--active" : ""}`}
          >
            <button type="button" className="tab__select" onClick={() => onSelect(tab.id)}>
              {tab.favicon ? (
                <img className="tab__favicon" src={tab.favicon} alt="" />
              ) : (
                <span className="tab__favicon tab__favicon--blank" />
              )}
              <span className="tab__title">{tab.loading ? "Loading…" : tab.title}</span>
              {tab.trackerCount > 0 && (
                <span
                  className="tab__trackers"
                  title={`${tab.trackerCount} third-party hosts contacted by this page`}
                >
                  {tab.trackerCount}
                </span>
              )}
            </button>
            <button
              type="button"
              className="tab__close"
              onClick={() => onClose(tab.id)}
              aria-label={`Close ${tab.title || "tab"}`}
            >
              ×
            </button>
          </div>
        ))}
      </div>

      <button type="button" className="tabs__new" onClick={onNew} title="New tab (⌘T)">
        +
      </button>
    </div>
  );
}
