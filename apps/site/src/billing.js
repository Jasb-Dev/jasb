/**
 * Checkout, once it exists.
 *
 * The pricing buttons ship as waitlist mailto links. On load we ask the API
 * whether billing is switched on, and only then load Paddle.js and turn them
 * into checkout. Until the Paddle account is live, the page stays as it is:
 * no third-party script and no dead "Buy" button.
 *
 * There are no accounts. Before checkout we make up a random claim token and
 * hand it to Paddle as custom data. When the payment clears, the webhook files
 * a licence key under that token, and /welcome.html collects it. The token
 * travels in the URL fragment, which browsers never send to a server.
 */

import { API } from "./api.js";

const PADDLE_JS = "https://cdn.paddle.com/paddle/v2/paddle.js";
export const CLAIM_KEY = "jasb.claim";

const LABELS = { pro: "Subscribe — $5/mo", supporter: "Support — $19 once" };

async function init() {
  const buttons = document.querySelectorAll("[data-plan]");
  if (buttons.length === 0) return;

  let config;
  try {
    const response = await fetch(`${API}/billing/config`);
    config = await response.json();
  } catch {
    return;
  }
  if (!config?.enabled) return;

  const offered = [...buttons].filter((button) => config.prices?.[button.dataset.plan]);
  if (offered.length === 0) return;

  try {
    await loadScript(PADDLE_JS);
  } catch {
    // Paddle's CDN is unreachable or blocked. The waitlist links still work.
    return;
  }

  const Paddle = window.Paddle;
  if (config.environment === "sandbox") Paddle.Environment.set("sandbox");
  Paddle.Initialize({ token: config.clientToken });

  for (const button of offered) {
    const plan = button.dataset.plan;
    button.textContent = LABELS[plan];
    button.removeAttribute("href");
    button.setAttribute("role", "button");
    button.tabIndex = 0;
    const open = (event) => {
      event.preventDefault();
      openCheckout(Paddle, config.prices[plan]);
    };
    button.addEventListener("click", open);
    button.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") open(event);
    });
  }

  const note = document.querySelector("#plan-note");
  if (note) {
    note.innerHTML =
      "Payments run through <strong>Paddle</strong> as merchant of record: they handle tax " +
      "and invoicing, and we never see a card number. No account needed — you get a " +
      "licence key right after checkout.";
  }
}

function openCheckout(Paddle, priceId) {
  const claim = crypto.randomUUID();
  try {
    localStorage.setItem(CLAIM_KEY, claim);
  } catch {
    // The fragment below still carries it.
  }

  Paddle.Checkout.open({
    items: [{ priceId, quantity: 1 }],
    customData: { claim },
    settings: {
      displayMode: "overlay",
      theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
      successUrl: `${location.origin}/welcome.html#claim=${claim}`,
    },
  });
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.onload = resolve;
    script.onerror = reject;
    document.head.append(script);
  });
}

void init();
