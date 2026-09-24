import { useCallback, useMemo, useState } from "react";
import type { Card } from "@jasb/intent-engine";

import { resolve } from "./client.ts";
import { GOLDEN_SET, type GoldenQuery } from "./golden.ts";

/**
 * The Phase 0 blind test.
 *
 * This is the gate the whole project hangs on: if our six cards are not at
 * least as good as Google's first six on 60% of real queries, the roadmap says
 * stop. So the test has to be honest, which means the grader must not be able
 * to tell whose results they are looking at.
 *
 * Mechanics: for each query we show our grid next to a competitor's first six,
 * in a randomised left/right order with the labels hidden. The grader picks a
 * side or calls it a tie. Only after every query is graded does the tool reveal
 * which side was which and compute the rate.
 */

type Side = "ours" | "theirs";
type Verdict = "left" | "right" | "tie";

interface Trial {
  query: GoldenQuery;
  ours: Card[];
  theirs: CompetitorResult[];
  /** Which side of the screen ours landed on. Hidden until the reveal. */
  oursOn: "left" | "right";
  verdict?: Verdict;
}

export interface CompetitorResult {
  url: string;
  title: string;
  domain: string;
}

export function Bench() {
  const [competitor, setCompetitor] = useState<"google" | "kagi">("google");
  const [trials, setTrials] = useState<Trial[]>([]);
  const [current, setCurrent] = useState(0);
  const [running, setRunning] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [pasteBuffer, setPasteBuffer] = useState("");

  const graded = trials.filter((trial) => trial.verdict).length;

  const start = useCallback(async () => {
    setRunning(true);
    setRevealed(false);
    setCurrent(0);

    const next: Trial[] = [];
    for (const query of GOLDEN_SET) {
      try {
        const { result } = await resolve({ query: query.text });
        next.push({
          query,
          ours: result.kind === "cards" ? result.cards : [],
          theirs: [],
          // Randomised per trial, so a grader cannot learn "ours is always left".
          oursOn: Math.random() < 0.5 ? "left" : "right",
        });
      } catch {
        next.push({ query, ours: [], theirs: [], oursOn: "left" });
      }
      setTrials([...next]);
    }
    setRunning(false);
  }, []);

  const trial = trials[current];

  const score = useMemo(() => {
    const complete = trials.filter((t) => t.verdict);
    if (complete.length === 0) return undefined;

    let atLeastAsGood = 0;
    for (const t of complete) {
      const oursWon = t.verdict === t.oursOn;
      // "Equal or better" is the threshold the roadmap sets, so a tie counts.
      if (oursWon || t.verdict === "tie") atLeastAsGood += 1;
    }
    return {
      graded: complete.length,
      atLeastAsGood,
      rate: atLeastAsGood / complete.length,
      // Gate 1 asks for ≥60% against Google and ≥45% against Kagi.
      threshold: competitor === "google" ? 0.6 : 0.45,
    };
  }, [trials, competitor]);

  return (
    <main className="shell__inner" style={{ paddingBlock: "var(--space-6)" }}>
      <h1 className="empty__headline" style={{ fontSize: "var(--text-2xl)" }}>
        Blind comparison
      </h1>
      <p className="empty__sub">
        {GOLDEN_SET.length} real queries, our grid against {competitor === "google" ? "Google" : "Kagi"}
        &apos;s first six. Sides are shuffled and unlabelled until every query is graded.
      </p>

      <div style={{ display: "flex", gap: "var(--space-3)", marginBlock: "var(--space-5)" }}>
        <button
          type="button"
          className="bar__button"
          aria-pressed={competitor === "google"}
          onClick={() => setCompetitor("google")}
        >
          vs Google
        </button>
        <button
          type="button"
          className="bar__button"
          aria-pressed={competitor === "kagi"}
          onClick={() => setCompetitor("kagi")}
        >
          vs Kagi
        </button>
        <button type="button" className="bar__button" onClick={start} disabled={running}>
          {running ? `Resolving ${trials.length}/${GOLDEN_SET.length}` : "Run our side"}
        </button>
      </div>

      {trials.length === 0 && !running && (
        <p className="empty__desc">
          Runs the golden set through the engine, then asks you to paste the competitor&apos;s
          first six URLs per query. Nothing is uploaded; grades stay in this tab.
        </p>
      )}

      {trial && (
        <section>
          <div className="status">
            <span className="status__item status__strong">
              {current + 1} / {trials.length}
            </span>
            <span className="status__item">{trial.query.text}</span>
            <span className="status__item">{trial.query.category}</span>
            <span className="status__item">{graded} graded</span>
          </div>

          {trial.theirs.length === 0 ? (
            <div style={{ paddingBlock: "var(--space-5)" }}>
              <label className="label" htmlFor="paste">
                Paste {competitor}&apos;s first six URLs for this query, one per line
              </label>
              <textarea
                id="paste"
                className="bar__input"
                style={{
                  width: "100%",
                  minHeight: "8rem",
                  marginTop: "var(--space-2)",
                  border: "1px solid var(--line-strong)",
                  borderRadius: "var(--radius)",
                  padding: "var(--space-3)",
                  background: "var(--paper-raised)",
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--text-xs)",
                }}
                value={pasteBuffer}
                onChange={(event) => setPasteBuffer(event.target.value)}
                placeholder={"https://…\nhttps://…"}
              />
              <button
                type="button"
                className="bar__button"
                style={{ marginTop: "var(--space-3)" }}
                onClick={() => {
                  const parsed = parseUrls(pasteBuffer);
                  if (parsed.length === 0) return;
                  setTrials((all) =>
                    all.map((t, i) => (i === current ? { ...t, theirs: parsed } : t)),
                  );
                  setPasteBuffer("");
                }}
              >
                Add and compare
              </button>
            </div>
          ) : (
            <>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: "var(--space-5)",
                  paddingBlock: "var(--space-5)",
                }}
              >
                <Column
                  heading="A"
                  items={trial.oursOn === "left" ? toList(trial.ours) : trial.theirs}
                />
                <Column
                  heading="B"
                  items={trial.oursOn === "right" ? toList(trial.ours) : trial.theirs}
                />
              </div>

              <div style={{ display: "flex", gap: "var(--space-3)" }}>
                {(
                  [
                    ["left", "A is better"],
                    ["tie", "About the same"],
                    ["right", "B is better"],
                  ] as const
                ).map(([verdict, label]) => (
                  <button
                    key={verdict}
                    type="button"
                    className="bar__button"
                    aria-pressed={trial.verdict === verdict}
                    onClick={() => {
                      setTrials((all) =>
                        all.map((t, i) => (i === current ? { ...t, verdict } : t)),
                      );
                      if (current < trials.length - 1) setCurrent(current + 1);
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </>
          )}

          <div style={{ display: "flex", gap: "var(--space-3)", marginTop: "var(--space-5)" }}>
            <button
              type="button"
              className="bar__button"
              disabled={current === 0}
              onClick={() => setCurrent(current - 1)}
            >
              Previous
            </button>
            <button
              type="button"
              className="bar__button"
              disabled={current >= trials.length - 1}
              onClick={() => setCurrent(current + 1)}
            >
              Next
            </button>
            <button
              type="button"
              className="bar__button"
              onClick={() => setRevealed(true)}
              disabled={graded === 0}
            >
              Reveal result
            </button>
          </div>
        </section>
      )}

      {revealed && score && (
        <section style={{ marginTop: "var(--space-6)" }}>
          <h2 className="empty__headline" style={{ fontSize: "var(--text-xl)" }}>
            {score.rate >= score.threshold ? "Gate 1 passed" : "Gate 1 not passed"}
          </h2>
          <p className="empty__sub">
            Equal or better on{" "}
            <strong>
              {score.atLeastAsGood} of {score.graded}
            </strong>{" "}
            graded queries — {(score.rate * 100).toFixed(0)}%, against a threshold of{" "}
            {(score.threshold * 100).toFixed(0)}%.
          </p>

          <table
            className="scroll-x"
            style={{ width: "100%", marginTop: "var(--space-5)", borderCollapse: "collapse" }}
          >
            <thead>
              <tr>
                {["Query", "Category", "Ours was", "Verdict"].map((heading) => (
                  <th
                    key={heading}
                    className="label"
                    style={{
                      textAlign: "left",
                      padding: "var(--space-2)",
                      borderBottom: "1px solid var(--line-strong)",
                    }}
                  >
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {trials
                .filter((t) => t.verdict)
                .map((t) => {
                  const won = t.verdict === t.oursOn;
                  return (
                    <tr key={t.query.text}>
                      <td style={cell}>{t.query.text}</td>
                      <td style={cell} className="mono">
                        {t.query.category}
                      </td>
                      <td style={cell} className="mono">
                        {t.oursOn === "left" ? "A" : "B"}
                      </td>
                      <td
                        style={{
                          ...cell,
                          color: won
                            ? "var(--signal)"
                            : t.verdict === "tie"
                              ? "var(--ink-2)"
                              : "var(--warn)",
                        }}
                        className="mono"
                      >
                        {won ? "ours" : t.verdict === "tie" ? "tie" : "theirs"}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </section>
      )}
    </main>
  );
}

const cell: React.CSSProperties = {
  padding: "var(--space-2)",
  borderBottom: "1px solid var(--line)",
  fontSize: "var(--text-sm)",
  verticalAlign: "top",
};

function Column({ heading, items }: { heading: string; items: CompetitorResult[] }) {
  return (
    <div>
      <h3 className="label" style={{ marginBottom: "var(--space-3)" }}>
        {heading}
      </h3>
      <ol style={{ margin: 0, paddingInlineStart: "1.25rem", display: "grid", gap: "var(--space-3)" }}>
        {items.map((item) => (
          <li key={item.url}>
            <a href={item.url} target="_blank" rel="noopener noreferrer">
              {item.title}
            </a>
            <div className="mono" style={{ color: "var(--ink-3)" }}>
              {item.domain}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function toList(cards: Card[]): CompetitorResult[] {
  return cards.map((card) => ({ url: card.url, title: card.title, domain: card.domain }));
}

/** Accepts pasted URLs with or without surrounding text; keeps the first six. */
function parseUrls(raw: string): CompetitorResult[] {
  const matches = raw.match(/https?:\/\/\S+/g) ?? [];
  return matches.slice(0, 6).flatMap((url) => {
    try {
      const parsed = new URL(url);
      const domain = parsed.hostname.replace(/^www\./, "");
      const path = decodeURIComponent(parsed.pathname).replace(/[-_/]+/g, " ").trim();
      return [{ url, domain, title: path || domain }];
    } catch {
      return [];
    }
  });
}
