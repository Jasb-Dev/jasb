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

import { mergeLocalCards, searchLocal } from "../shared/local.ts";
import { blockDomain, loadRules, pinDomain, unpinDomain } from "../shared/rules.ts";
import { resolveViaServer } from "../shared/client.ts";
import { Settings } from "./Settings.tsx";

type View =
  | { status: "idle" }
  | { status: "loading"; query: string }
  | { status: "cards"; result: Extract<ResolveResult, { kind: "cards" }> }
  | { status: "error"; title: string; body: string };

/**
 * The new-tab page.
 *
 * Identical surface to the web app by design — same tokens, same components,
 * same keyboard map. The difference is underneath: results from the open web
 * are merged with the user's own bookmarks and history, which the extension can
 * read and the standalone browser cannot.
 */
export function NewTab() {
  const [theme, setTheme] = useTheme();
  const [input, setInput] = useState("");
  const [view, setView] = useState<View>({ status: "idle" });
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Shown once, when the background script opens this page after install.
  const [welcome, setWelcome] = useState(
    () => new URLSearchParams(window.location.search).get("welcome") === "1",
  );
  const [rules, setRules] = useState({ blocked: [] as string[], pinned: [] as string[] });

  useEffect(() => {
    void loadRules().then(setRules);
  }, []);

  const run = useCallback(async (rawQuery: string, options: { refresh?: boolean } = {}) => {
    const query = rawQuery.trim();
    if (!query) return;

    setInput(query);
    setView({ status: "loading", query });

    // The local lookup is instant and offline, so it always runs — even if the
    // server is unreachable the user still gets their own pages back.
    const localPromise = searchLocal(query);

    try {
      const [result, local] = await Promise.all([resolveViaServer(query, options), localPromise]);

      if (result.kind === "navigate") {
        window.location.href = result.url;
        return;
      }

      const current = await loadRules();
      setRules(current);

      const blocked = new Set(current.blocked);
      const pinned = new Set(current.pinned);
      const web = result.cards
        .filter((card) => !blocked.has(card.domain))
        .map((card) => ({ ...card, pinned: pinned.has(card.domain) }));

      setView({
        status: "cards",
        result: { ...result, cards: mergeLocalCards(local, web, 6) },
      });
    } catch (error) {
      const local = await localPromise;
      if (local.length > 0) {
        // Server down, but the user's own web is right here. Show it rather
        // than an empty error page.
        setView({
          status: "cards",
          result: {
            kind: "cards",
            query,
            intent: "navigational",
            lens: "general",
            cards: mergeLocalCards(local, [], 6),
            cached: false,
            lowConfidence: true,
            tookMs: 0,
            timings: {},
          },
        });
        return;
      }

      setView({
        status: "error",
        title: "That search did not complete",
        body:
          error instanceof Error
            ? `${error.message}. Check that the Jasb server is running.`
            : "Check that the Jasb server is running.",
      });
    }
  }, []);

  // The omnibox hands off through `?q=`; run it as soon as the page mounts.
  useEffect(() => {
    const query = new URLSearchParams(window.location.search).get("q");
    if (query) void run(query);
  }, [run]);

  // A result opens in a new Chrome tab, so the new-tab page (and the grid)
  // stays where it is. ⌘/Ctrl- and middle-click open it in the background.
  // chrome.tabs.create needs no permission beyond what the extension has.
  const openCard = useCallback((card: Card, options?: { background?: boolean }) => {
    void chrome.tabs.create({ url: card.url, active: !options?.background });
  }, []);

  useEffect(() => {
    if (view.status !== "cards") return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.tagName === "INPUT" || target?.isContentEditable) return;

      const index = Number.parseInt(event.key, 10);
      const card = view.status === "cards" ? view.result.cards[index - 1] : undefined;
      if (!card) return;

      event.preventDefault();
      openCard(card);
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [view, openCard]);

  const onBlock = useCallback(async (domain: string) => {
    await blockDomain(domain);
    setRules(await loadRules());
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
      if (rules.pinned.includes(domain)) await unpinDomain(domain);
      else await pinDomain(domain);

      const next = await loadRules();
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
      <IntentBar
        value={input}
        onChange={setInput}
        onSubmit={run}
        busy={view.status === "loading"}
        actions={
          <>
            {view.status === "cards" && (
              <IconButton
                icon="refresh"
                label="Refresh"
                title="Re-run this search, ignoring the cache"
                onClick={() => run(view.result.query, { refresh: true })}
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

      <main className="shell__inner" style={{ flex: 1 }}>
        {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} />}

        {view.status === "idle" && !settingsOpen && welcome && (
          <aside className="ext-welcome">
            <div>
              <strong>Jasb is set up.</strong> This page is your new tab: type what you want, get
              the right sites.
              <ul>
                <li>
                  From anywhere, type <kbd>j</kbd> then <kbd>space</kbd> in Chrome's address bar.
                </li>
                <li>Your bookmarks and history show up in results, and never leave this browser.</li>
                <li>Results open in a new tab; ⌘/Ctrl-click opens them in the background.</li>
              </ul>
            </div>
            <button type="button" onClick={() => setWelcome(false)}>
              Got it
            </button>
          </aside>
        )}
        {view.status === "idle" && !settingsOpen && <EmptyState onPick={run} />}

        {view.status === "loading" && (
          <>
            <div className="status" role="status">
              <span className="status__item">
                <span className="status__dot" />
                <span className="status__strong">searching</span>
              </span>
              <span className="status__item">{view.query}</span>
            </div>
            <ul className="grid">
              {Array.from({ length: 6 }, (_, i) => (
                <SkeletonCard key={i} index={i} />
              ))}
            </ul>
          </>
        )}

        {view.status === "cards" && (
          <>
            <StatusLine
              result={view.result}
              onOpenAll={() => {
                for (const card of view.result.cards) openCard(card, { background: true });
              }}
            />
            {view.result.cards.length === 0 ? (
              <Notice
                title="No sites came back for that"
                body="Every source either returned nothing or is unreachable, and nothing in your bookmarks or history matched. Try different words."
              />
            ) : (
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
            )}
          </>
        )}

        {view.status === "error" && <Notice title={view.title} body={view.body} />}
      </main>

      <footer
        className="shell__inner"
        style={{
          borderTop: "1px solid var(--line)",
          paddingBlock: "var(--space-4)",
          display: "flex",
          gap: "var(--space-4)",
          flexWrap: "wrap",
        }}
      >
        <span className="mono" style={{ color: "var(--ink-3)" }}>
          Type <strong>j</strong> then space in the address bar to search from anywhere
        </span>
        <span className="mono" style={{ color: "var(--ink-3)", marginInlineStart: "auto" }}>
          Your bookmarks and history never leave this browser
        </span>
      </footer>
    </div>
  );
}
