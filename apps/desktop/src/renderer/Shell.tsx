import { useCallback, useEffect, useState } from "react";
import type { Card, ResolveResult } from "@jasb/intent-engine";
import {
  EmptyState,
  IconButton,
  IntentBar,
  Notice,
  ResultCard,
  SkeletonCard,
  StatusLine,
  ThemeToggle,
  useTheme,
} from "@jasb/ui";

import { TabStrip } from "./TabStrip.tsx";
import { DesktopSettings } from "./DesktopSettings.tsx";
import type { DesktopApi, ShellState } from "../shared/ipc.ts";

declare global {
  interface Window {
    jasb: DesktopApi;
  }
}

type View =
  | { status: "idle" }
  | { status: "loading"; query: string }
  | { status: "cards"; result: Extract<ResolveResult, { kind: "cards" }> }
  | { status: "error"; title: string; body: string };

/**
 * The browser chrome.
 *
 * This renderer never shows a web page — pages live in their own views,
 * layered on top. What it owns is the tab strip, the intent bar, and the card
 * grid that sits behind everything when no page is in front.
 */
export function Shell() {
  const [theme, setTheme] = useTheme();
  const [input, setInput] = useState("");
  const [view, setView] = useState<View>({ status: "idle" });
  const [shell, setShell] = useState<ShellState>({
    tabs: [],
    activeTabId: undefined,
    showingCards: true,
  });
  const [rules, setRules] = useState({ blocked: [] as string[], pinned: [] as string[] });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [history, setHistory] = useState<{ query: string; at: number }[]>([]);

  useEffect(() => window.jasb.onShellState(setShell), []);

  // Back/forward availability comes from the page in front, not from our own
  // history, so the buttons have to read it off the shell state.
  const activeTab = shell.tabs.find((tab) => tab.id === shell.activeTabId);

  useEffect(() => {
    void window.jasb.getRules().then(setRules);
    void window.jasb.getHistory(8).then(setHistory);
  }, []);

  const run = useCallback(async (rawQuery: string, options: { refresh?: boolean } = {}) => {
    const query = rawQuery.trim();
    if (!query) return;

    setInput(query);
    setView({ status: "loading", query });

    try {
      const result = await window.jasb.resolve(query, options);

      if (result.kind === "navigate") {
        // The main process already pointed the active tab at it; all the chrome
        // has to do is get out of the way.
        setView({ status: "idle" });
        return;
      }

      const current = await window.jasb.getRules();
      setRules(current);

      const blocked = new Set(current.blocked);
      const pinned = new Set(current.pinned);
      setView({
        status: "cards",
        result: {
          ...result,
          cards: result.cards
            .filter((card) => !blocked.has(card.domain))
            .map((card) => ({ ...card, pinned: pinned.has(card.domain) }))
            .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.score - a.score),
        },
      });
      void window.jasb.getHistory(8).then(setHistory);
    } catch (error) {
      setView({
        status: "error",
        title: "That search did not complete",
        body:
          error instanceof Error
            ? `${error.message}. Add a search provider key in settings, or check your connection.`
            : "Add a search provider key in settings, or check your connection.",
      });
    }
  }, []);

  const openCard = useCallback((card: Card) => {
    void window.jasb.openCard(card);
  }, []);

  // Browser-grade keyboard map. ⌘T, ⌘W, ⌘R, ⌘[ / ⌘] and 1–6 for cards.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const mod = event.metaKey || event.ctrlKey;
      const target = event.target as HTMLElement | null;
      const typing = target?.tagName === "INPUT" || target?.isContentEditable;

      if (mod) {
        switch (event.key.toLowerCase()) {
          case "t":
            event.preventDefault();
            void window.jasb.newTab();
            return;
          case "w":
            if (shell.activeTabId !== undefined) {
              event.preventDefault();
              void window.jasb.closeTab(shell.activeTabId);
            }
            return;
          case "r":
            event.preventDefault();
            void window.jasb.reload();
            return;
          case "[":
            event.preventDefault();
            void window.jasb.goBack();
            return;
          case "]":
            event.preventDefault();
            void window.jasb.goForward();
            return;
          default:
            break;
        }
      }

      if (typing || mod || event.altKey) return;

      if (event.key === "Escape" && !shell.showingCards) {
        event.preventDefault();
        void window.jasb.showCards();
        return;
      }

      if (view.status === "cards") {
        const index = Number.parseInt(event.key, 10);
        const card = view.result.cards[index - 1];
        if (card) {
          event.preventDefault();
          openCard(card);
        }
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [view, shell, openCard]);

  const onBlock = useCallback(async (domain: string) => {
    await window.jasb.block(domain);
    setRules(await window.jasb.getRules());
    setView((current) =>
      current.status === "cards"
        ? {
            ...current,
            result: {
              ...current.result,
              cards: current.result.cards.filter((card) => card.domain !== domain),
            },
          }
        : current,
    );
  }, []);

  const onPin = useCallback(
    async (domain: string) => {
      if (rules.pinned.includes(domain)) await window.jasb.unpin(domain);
      else await window.jasb.pin(domain);

      const next = await window.jasb.getRules();
      setRules(next);
      const pinned = new Set(next.pinned);

      setView((current) =>
        current.status === "cards"
          ? {
              ...current,
              result: {
                ...current.result,
                cards: [...current.result.cards]
                  .map((card) => ({ ...card, pinned: pinned.has(card.domain) }))
                  .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.score - a.score),
              },
            }
          : current,
      );
    },
    [rules.pinned],
  );

  return (
    <div className="shell">
      <TabStrip
        tabs={shell.tabs}
        activeTabId={shell.activeTabId}
        showingCards={shell.showingCards}
        onSelect={(id) => void window.jasb.selectTab(id)}
        onClose={(id) => void window.jasb.closeTab(id)}
        onNew={() => void window.jasb.newTab()}
        onShowCards={() => void window.jasb.showCards()}
      />

      <IntentBar
        value={input}
        onChange={setInput}
        onSubmit={run}
        busy={view.status === "loading"}
        actions={
          <>
            <IconButton
              icon="back"
              label="Back"
              title="Back (⌘[)"
              onClick={() => void window.jasb.goBack()}
              disabled={!activeTab?.canGoBack}
              iconOnly
            />
            <IconButton
              icon="forward"
              label="Forward"
              title="Forward (⌘])"
              onClick={() => void window.jasb.goForward()}
              disabled={!activeTab?.canGoForward}
              iconOnly
            />
            <IconButton
              icon="refresh"
              label="Reload"
              title="Reload (⌘R)"
              onClick={() => void window.jasb.reload()}
              disabled={shell.showingCards}
              iconOnly
            />
            {!shell.showingCards && activeTab && (
              <IconButton
                icon="shield"
                label={
                  activeTab.adblockPaused
                    ? "Blocking paused"
                    : `${activeTab.blockedCount} blocked`
                }
                title={
                  activeTab.adblockPaused
                    ? "Ad blocking is paused on this site. Click to turn it back on."
                    : `${activeTab.blockedCount} ads and trackers blocked on this page. ` +
                      "Click to pause blocking on this site if something looks broken."
                }
                pressed={!activeTab.adblockPaused}
                onClick={() => void window.jasb.toggleAdblockForActiveSite()}
              />
            )}
            <IconButton
              icon="settings"
              label="Settings"
              pressed={settingsOpen}
              onClick={() => setSettingsOpen((open) => !open)}
            />
            <ThemeToggle theme={theme} onChange={setTheme} />
          </>
        }
      />

      <main className="shell__inner" style={{ flex: 1, overflowY: "auto" }}>
        {settingsOpen && <DesktopSettings onClose={() => setSettingsOpen(false)} />}

        {!settingsOpen && view.status === "idle" && (
          <>
            <EmptyState onPick={run} />
            {history.length > 0 && (
              <section style={{ paddingBottom: "var(--space-7)" }}>
                <h2 className="label" style={{ marginBottom: "var(--space-3)" }}>
                  Recent — stored only on this Mac
                </h2>
                <ul className="empty__list" style={{ marginTop: 0 }}>
                  {history.map((entry) => (
                    <li key={entry.query} className="empty__item">
                      <button
                        type="button"
                        className="empty__key"
                        style={{ textAlign: "left", color: "var(--signal)" }}
                        onClick={() => run(entry.query)}
                      >
                        {entry.query}
                      </button>
                      <span className="empty__desc mono">
                        {new Date(entry.at).toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                        })}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}

        {!settingsOpen && view.status === "loading" && (
          <ul className="grid">
            {Array.from({ length: 6 }, (_, i) => (
              <SkeletonCard key={i} index={i} />
            ))}
          </ul>
        )}

        {!settingsOpen && view.status === "cards" && (
          <>
            <StatusLine result={view.result} />
            <ul className="grid">
              {view.result.cards.map((card, index) => (
                <ResultCard
                  key={card.url}
                  card={card}
                  index={index + 1}
                  onOpen={openCard}
                  onBlock={onBlock}
                  onPin={onPin}
                />
              ))}
            </ul>
          </>
        )}

        {!settingsOpen && view.status === "error" && (
          <Notice
            title={view.title}
            body={view.body}
            actionLabel="Open settings"
            onAction={() => setSettingsOpen(true)}
          />
        )}
      </main>
    </div>
  );
}
