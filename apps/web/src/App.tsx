import { useCallback, useEffect, useRef, useState } from "react";
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

import { QuotaExceededError, fetchQuota, resolve, type QuotaState } from "./client.ts";
import { Settings } from "./Settings.tsx";
import {
  createPreferenceStore,
  hasByok,
  readByok,
  recordSearch,
  recentSearches,
} from "./storage.ts";

type View =
  | { status: "idle" }
  | { status: "loading"; query: string }
  | { status: "cards"; result: Extract<ResolveResult, { kind: "cards" }> }
  | { status: "error"; title: string; body: string; action?: "settings" };

const preferences = createPreferenceStore();

export function App() {
  const [theme, setTheme] = useTheme();
  const [input, setInput] = useState("");
  const [view, setView] = useState<View>({ status: "idle" });
  const [quota, setQuota] = useState<QuotaState | undefined>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [history, setHistory] = useState(() => recentSearches());

  // Each new search cancels the one before it. Without this, a fast typist
  // gets the *earlier* query's results painted over the later one's.
  const inFlight = useRef<AbortController>(null);

  useEffect(() => {
    if (!hasByok(readByok())) void fetchQuota().then(setQuota);
  }, []);

  const run = useCallback(
    async (rawQuery: string, options: { refresh?: boolean } = {}) => {
      const query = rawQuery.trim();
      if (!query) return;

      inFlight.current?.abort();
      const controller = new AbortController();
      inFlight.current = controller;

      setInput(query);
      setView({ status: "loading", query });

      try {
        const { result, quota: nextQuota } = await resolve({
          query,
          ...(options.refresh ? { refresh: true } : {}),
          signal: controller.signal,
        });

        if (controller.signal.aborted) return;

        if (result.kind === "navigate") {
          // A URL, a bang or a navigation-index hit. In the browser build the
          // only honest thing to do is actually go there.
          window.location.href = result.url;
          return;
        }

        // The server ranks anonymously; this device gets the last word.
        const { blocked, pinned } = preferences.snapshot();
        const blockedSet = new Set(blocked);
        const pinnedSet = new Set(pinned);
        const cards = result.cards
          .filter((card) => !blockedSet.has(card.domain))
          .map((card) => ({ ...card, pinned: pinnedSet.has(card.domain) }))
          .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.score - a.score);

        setView({ status: "cards", result: { ...result, cards } });
        if (nextQuota.limit >= 0) setQuota(nextQuota);

        recordSearch(query);
        setHistory(recentSearches());
      } catch (error) {
        if (controller.signal.aborted) return;

        if (error instanceof QuotaExceededError) {
          setQuota(error.quota);
          setView({
            status: "error",
            title:
              error.plan === "pro"
                ? "You have reached this month's fair-use limit"
                : error.plan === "starter"
                  ? "This month's 300 Starter searches are used up"
                  : "This month's 50 free searches are used up",
            body:
              `It resets in ${Math.ceil(error.quota.resetInSeconds / 86_400)} days. URLs, bangs and ` +
              "repeat searches never count. For more, Jasb Search Unlimited is $6 a month " +
              "(jasb.dev/#pricing), or add your own provider keys and search without limits, free.",
            action: "settings",
          });
          return;
        }

        setView({
          status: "error",
          title: "That search did not complete",
          body:
            error instanceof Error
              ? `${error.message}. Check that the server is running, then try again.`
              : "Check that the server is running, then try again.",
        });
      }
    },
    [],
  );

  const openCard = useCallback((card: Card) => {
    window.open(card.url, "_blank", "noopener,noreferrer");
  }, []);

  // Digits 1–6 open the matching card, the way the badges promise.
  useEffect(() => {
    if (view.status !== "cards") return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const target = event.target as HTMLElement | null;
      if (target?.tagName === "INPUT" || target?.isContentEditable) return;

      const index = Number.parseInt(event.key, 10);
      if (!Number.isInteger(index) || index < 1) return;

      const card = view.status === "cards" ? view.result.cards[index - 1] : undefined;
      if (!card) return;

      event.preventDefault();
      openCard(card);
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [view, openCard]);

  const onBlock = useCallback(
    async (domain: string) => {
      await preferences.block(domain);
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
    },
    [],
  );

  const onPin = useCallback(async (domain: string) => {
    const { pinned } = preferences.snapshot();
    if (pinned.includes(domain)) await preferences.unpin(domain);
    else await preferences.pin(domain);

    const next = new Set(preferences.snapshot().pinned);
    setView((current) =>
      current.status === "cards"
        ? {
            ...current,
            result: {
              ...current.result,
              cards: [...current.result.cards]
                .map((card) => ({ ...card, pinned: next.has(card.domain) }))
                .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.score - a.score),
            },
          }
        : current,
    );
  }, []);

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

        {view.status === "idle" && !settingsOpen && (
          <>
            <EmptyState onPick={run} />
            {history.length > 0 && <RecentSearches history={history} onPick={run} />}
          </>
        )}

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
            <StatusLine result={view.result} quotaRemaining={quota?.remaining} />
            {view.result.cards.length === 0 ? (
              <Notice
                title="No sites came back for that"
                body="Every source either returned nothing or is unreachable. Try different words, or check the server's search provider key."
                actionLabel="Open settings"
                onAction={() => setSettingsOpen(true)}
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

        {view.status === "error" && (
          <Notice
            title={view.title}
            body={view.body}
            {...(view.action === "settings"
              ? { actionLabel: "Add your own key", onAction: () => setSettingsOpen(true) }
              : {})}
          />
        )}
      </main>

      <Footer />
    </div>
  );
}

function RecentSearches({
  history,
  onPick,
}: {
  history: { query: string; at: number }[];
  onPick(query: string): void;
}) {
  return (
    <section style={{ paddingBottom: "var(--space-7)" }}>
      <h2 className="label" style={{ marginBottom: "var(--space-3)" }}>
        Recent — on this device only
      </h2>
      <ul className="empty__list" style={{ marginTop: 0 }}>
        {history.map((entry) => (
          <li key={entry.query} className="empty__item">
            <button
              type="button"
              className="empty__key"
              style={{ textAlign: "left", color: "var(--signal)" }}
              onClick={() => onPick(entry.query)}
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
  );
}

function Footer() {
  return (
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
        No chat · No agents · No ads
      </span>
      <span className="mono" style={{ color: "var(--ink-3)" }}>
        History and preferences stay on this device
      </span>
      <span className="mono" style={{ color: "var(--ink-3)", marginInlineStart: "auto" }}>
        Results via Brave Search
      </span>
    </footer>
  );
}
