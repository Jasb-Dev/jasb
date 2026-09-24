/**
 * The landing page's script.
 *
 * It runs the demo box against the real `/resolve` endpoint, and (through
 * billing.js) turns the pricing buttons into checkout once billing is live.
 * Everything else on the page is static HTML, because a site whose argument is
 * "we do less" should not need a framework to make that argument.
 *
 * Written in plain JavaScript rather than TypeScript so the site builds with
 * no compile step beyond Vite's own bundling.
 */

import "./site.css";

import { API } from "./api.js";
import "./billing.js";

const DEVICE_KEY = "jasb.demo.device";

const form = document.querySelector("#demo-form");
const input = document.querySelector("#demo-input");
const grid = document.querySelector("#demo-grid");
const status = document.querySelector("#demo-status");
const hint = document.querySelector("#demo-hint");

/**
 * The anonymous device token.
 *
 * Random, made up here, never derived from anything about the visitor. It
 * exists only so the server can count five searches a day without knowing who
 * is making them.
 */
function deviceToken() {
  let token = null;
  try {
    token = localStorage.getItem(DEVICE_KEY);
    if (!token) {
      token = crypto.randomUUID();
      localStorage.setItem(DEVICE_KEY, token);
    }
  } catch {
    // Storage blocked. A per-session token still works; the visitor just gets
    // a fresh allowance next time, which is the generous failure.
    token ??= crypto.randomUUID();
  }
  return token;
}

let inFlight = null;

async function run(query) {
  const trimmed = query.trim();
  if (!trimmed) return;

  // A fast typist clicking two examples in a row must not get the first one's
  // results painted over the second's.
  inFlight?.abort();
  const controller = new AbortController();
  inFlight = controller;

  input.value = trimmed;
  setStatus("Searching…");
  renderSkeletons();

  try {
    const response = await fetch(`${API}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-jasb-device": deviceToken() },
      body: JSON.stringify({ query: trimmed, demo: true, maxCards: 6 }),
      signal: controller.signal,
    });

    if (response.status === 429) {
      const body = await response.json().catch(() => ({}));
      renderCards([]);
      setStatus(
        body.hint ?? "That is all the demo allows today. Install the browser to keep going.",
        true,
      );
      return;
    }

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error ?? `server returned ${response.status}`);
    }

    const { result, quota, degraded } = await response.json();
    if (controller.signal.aborted) return;

    if (result.kind === "navigate") {
      // A URL, a bang or a navigation-index hit. Show where it would take you
      // rather than navigating the marketing page away from itself.
      renderCards([]);
      setStatus(
        `That is a destination, not a search — Jasb would open ${result.url} immediately, with no model and no API call.`,
      );
      return;
    }

    renderCards(result.cards);

    const parts = [
      `${result.cards.length} sites`,
      result.cached ? "from cache" : `${Math.round(result.tookMs)} ms`,
      result.intent,
    ];
    if (result.lowConfidence) parts.push("low confidence — showing fewer");
    if (typeof quota?.remaining === "number" && quota.remaining >= 0) {
      parts.push(`${quota.remaining} demo searches left today`);
    }
    if (degraded) parts.push("free sources only — today's demo budget is spent");

    setStatus(parts.join(" · "), Boolean(degraded) || result.lowConfidence);
  } catch (error) {
    if (controller.signal.aborted) return;
    renderCards([]);
    setStatus(
      `The demo could not reach the search service${
        error instanceof Error && error.message ? ` (${error.message})` : ""
      }. The downloadable browser runs the same engine locally.`,
      true,
    );
  }
}

function renderSkeletons() {
  hint.hidden = true;
  grid.hidden = false;
  grid.innerHTML = "";
  for (let i = 0; i < 3; i += 1) {
    const li = document.createElement("li");
    li.className = "demo__card";
    li.style.opacity = "0.45";
    li.innerHTML =
      '<span class="demo__reason" style="opacity:.4">&nbsp;&nbsp;&nbsp;&nbsp;</span>' +
      '<span class="demo__title" style="background:var(--paper-sunken);border-radius:2px">&nbsp;</span>' +
      '<span class="demo__domain" style="background:var(--paper-sunken);border-radius:2px;width:55%">&nbsp;</span>';
    grid.append(li);
  }
}

function renderCards(cards) {
  grid.innerHTML = "";

  if (cards.length === 0) {
    grid.hidden = true;
    hint.hidden = false;
    return;
  }

  hint.hidden = true;
  grid.hidden = false;

  for (const card of cards) {
    const li = document.createElement("li");
    const link = document.createElement("a");
    link.className = "demo__card";
    link.href = card.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";

    const reason = document.createElement("span");
    reason.className = "demo__reason";
    reason.textContent = card.reason;

    const title = document.createElement("span");
    title.className = "demo__title";
    // `textContent`, never `innerHTML`: these strings come from third-party
    // pages and are not ours to trust.
    title.textContent = card.title;

    const domain = document.createElement("span");
    domain.className = "demo__domain";
    const trackers = card.signals?.trackers;
    domain.textContent =
      trackers === undefined
        ? card.domain
        : `${card.domain} · ${trackers === 0 ? "no trackers" : `${trackers} trackers`}`;

    link.append(reason, title, domain);
    li.append(link);
    grid.append(li);
  }
}

function setStatus(text, warn = false) {
  status.textContent = text;
  status.className = warn ? "demo__status demo__status--warn" : "demo__status";
}

form?.addEventListener("submit", (event) => {
  event.preventDefault();
  void run(input.value);
});

for (const chip of document.querySelectorAll("[data-q]")) {
  chip.addEventListener("click", () => void run(chip.dataset.q ?? ""));
}

// Deep link: /?q=… runs immediately, so a shared link shows a real result.
const initial = new URLSearchParams(location.search).get("q");
if (initial) void run(initial);
