/**
 * Collects the licence key after checkout.
 *
 * The claim token comes from the URL fragment (or, if the fragment was lost,
 * the copy billing.js left in localStorage). We poll until the webhook has
 * landed, which is usually a second or two and occasionally longer.
 */

import "./site.css";

import { API } from "./api.js";

const CLAIM_KEY = "jasb.claim";
const POLL_MS = 2000;
const GIVE_UP_MS = 3 * 60 * 1000;

const status = document.querySelector("#welcome-status");
const row = document.querySelector("#welcome-key-row");
const keyEl = document.querySelector("#welcome-key");
const copy = document.querySelector("#welcome-copy");
const planEl = document.querySelector("#welcome-plan");

function claimToken() {
  const fromHash = new URLSearchParams(location.hash.slice(1)).get("claim");
  if (fromHash) return fromHash;
  try {
    return localStorage.getItem(CLAIM_KEY);
  } catch {
    return null;
  }
}

function say(html) {
  status.innerHTML = html;
}

async function poll(token, started) {
  try {
    const response = await fetch(`${API}/billing/claim?token=${encodeURIComponent(token)}`);
    if (response.ok) {
      const { key, plan } = await response.json();
      show(key, plan);
      return;
    }
  } catch {
    // Network blip; keep trying until the deadline.
  }

  if (Date.now() - started > GIVE_UP_MS) {
    say(
      "<strong>The key has not arrived yet.</strong> Your payment is safe. Keep this page " +
        "open and reload it in a few minutes, or email " +
        '<a href="mailto:contact@jasb.dev">contact@jasb.dev</a> with your Paddle receipt.',
    );
    return;
  }
  setTimeout(() => void poll(token, started), POLL_MS);
}

function show(key, plan) {
  planEl.textContent =
    plan === "pro"
      ? "Jasb Search Unlimited is active."
      : plan === "starter"
        ? "Jasb Search Starter is active: 300 searches a month."
        : "Thank you for supporting Jasb. Your lifetime Supporter licence is below.";
  say("<strong>Your licence key</strong>");
  keyEl.textContent = key;
  row.hidden = false;

  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(key);
      copy.textContent = "Copied";
    } catch {
      // Clipboard blocked: select it so ⌘C works.
      getSelection()?.selectAllChildren(keyEl);
      copy.textContent = "Press ⌘C";
    }
  });
}

const token = claimToken();
if (token) {
  void poll(token, Date.now());
} else {
  say(
    "<strong>No purchase found in this browser.</strong> If you just paid, open the link from " +
      "the same browser you checked out in, or email " +
      '<a href="mailto:contact@jasb.dev">contact@jasb.dev</a> with your Paddle receipt.',
  );
}
