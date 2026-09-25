/**
 * Declines cookie consent pop-ups, the way DuckDuckGo's browser does.
 *
 * Uses DuckDuckGo's open-source AutoConsent (MPL-2.0): a content script that
 * recognises 2,800+ consent platforms and clicks "reject" (or "necessary
 * only") for you. Clicking matters: hiding a banner leaves the site's consent
 * logic unanswered, which can break the page or let trackers load anyway.
 *
 * Wiring, because pages run sandboxed: at startup we write one preload file
 * made of a small message bridge plus the library, and register it for every
 * frame of the pages session. The bridge asks the main process for the rules
 * (so a paused site simply gets none), runs the library's main-world checks
 * with webFrame, and reports back which pop-up it handled.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { ipcMain, type Session } from "electron";

const INIT_CHANNEL = "jasb:autoconsent-init";
/** JASB_DEBUG_COOKIES=1 logs what the content script reports. */
const DEBUG = Boolean(process.env.JASB_DEBUG_COOKIES);
const EVENT_CHANNEL = "jasb:autoconsent-event";

const CONFIG = {
  enabled: true,
  autoAction: "optOut",
  disabledCmps: [],
  enablePrehide: true,
  enableCosmeticRules: true,
  enableGeneratedRules: true,
  enableHeuristicDetection: true,
  heuristicMode: "tier2",
  detectRetries: 20,
  isMainWorld: false,
  prehideTimeout: 2000,
  logs: {
    lifecycle: false,
    rulesteps: false,
    detectionsteps: false,
    evals: false,
    errors: false,
    messages: false,
    waits: false,
  },
};

/** Runs in each page frame's isolated world, before the library. */
const BRIDGE = `
const { ipcRenderer, webFrame } = require("electron");
const reply = (message) => { try { window.autoconsentReceiveMessage && window.autoconsentReceiveMessage(message); } catch (_) {} };
window.autoconsentSendMessage = async (message) => {
  if (!message || typeof message !== "object") return;
  if (message.type === "init") {
    const init = await ipcRenderer.invoke(${JSON.stringify(INIT_CHANNEL)}, location.href);
    if (init) reply({ type: "initResp", config: init.config, rules: init.rules });
  } else if (message.type === "eval") {
    let result = false;
    try { result = await webFrame.executeJavaScript(message.code); } catch (_) {}
    reply({ type: "evalResp", id: message.id, result });
  } else if (${DEBUG ? "true" : '["autoconsentDone", "optOutResult"].includes(message.type)'}) {
    ipcRenderer.send(${JSON.stringify(EVENT_CHANNEL)}, { type: message.type, cmp: message.cmp, result: message.result });
  }
};
`;

/** AutoConsent's rule names are internal ids; show the product people know. */
const CMP_NAMES: Record<string, string> = {
  cybotcookiebot: "Cookiebot",
  onetrust: "OneTrust",
  "sourcepoint-frame": "Sourcepoint",
  "sourcepoint-top": "Sourcepoint",
  didomi: "Didomi",
  quantcast: "Quantcast Choice",
  trustarc: "TrustArc",
  usercentrics: "Usercentrics",
  "usercentrics-button": "Usercentrics",
  iubenda: "iubenda",
  cookieyes: "CookieYes",
  complianz: "Complianz",
  consentmanager: "consentmanager",
};

export function cmpName(id: string): string {
  const key = id.toLowerCase();
  return CMP_NAMES[key] ?? id.replace(/^(?:auto_|heuristic_)/i, "").replace(/[-_]/g, " ");
}

export class CookiePopups {
  #rules: unknown;
  #preloadId: string | undefined;
  #session: Session;
  #preloadPath: string;

  constructor(
    session: Session,
    options: {
      /** Where the generated preload is written (userData). */
      dir: string;
      /** Whether to act on a frame at this URL: the feature switch and per-site pause. */
      allowed(url: string): boolean;
      /** A pop-up was declined in this tab. */
      onHandled(webContentsId: number, cmp: string): void;
    },
  ) {
    this.#session = session;
    const require = createRequire(import.meta.url);
    // The package exports only its entry points, not package.json; the CJS
    // entry sits in dist/, next to the standalone content script.
    const distDir = dirname(require.resolve("@duckduckgo/autoconsent"));
    const library = readFileSync(join(distDir, "autoconsent.playwright.js"), "utf8");
    this.#rules = JSON.parse(
      readFileSync(require.resolve("@duckduckgo/autoconsent/rules/compact-rules.json"), "utf8"),
    );

    this.#preloadPath = join(options.dir, "autoconsent-preload.js");
    writeFileSync(this.#preloadPath, `${BRIDGE}\n${library}\n`);

    ipcMain.handle(INIT_CHANNEL, (_event, url: string) => {
      const allowed = options.allowed(url);
      if (DEBUG) console.log("[cookies] init", allowed, url.slice(0, 80));
      return allowed ? { config: CONFIG, rules: this.#rules } : null;
    });
    ipcMain.on(EVENT_CHANNEL, (event, message: { type: string; cmp?: string; result?: boolean }) => {
      if (DEBUG) console.log("[cookies]", message.type, message.cmp ?? "", message.result ?? "");
      if (message.type === "autoconsentDone" && message.cmp) {
        options.onHandled(event.sender.id, cmpName(message.cmp));
      }
    });
  }

  /** Turns the content script on or off for new page loads. */
  setEnabled(enabled: boolean): void {
    if (enabled && this.#preloadId === undefined) {
      this.#preloadId = this.#session.registerPreloadScript({ type: "frame", filePath: this.#preloadPath });
    } else if (!enabled && this.#preloadId !== undefined) {
      this.#session.unregisterPreloadScript(this.#preloadId);
      this.#preloadId = undefined;
    }
  }
}
