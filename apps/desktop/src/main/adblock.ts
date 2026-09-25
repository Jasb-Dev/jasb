/**
 * Ad and tracker blocking for the pages session.
 *
 * Built on Ghostery's open-source engine (EasyList, EasyPrivacy and friends,
 * pre-compiled and served by Ghostery's CDN, cached on disk for a week).
 *
 * The one Electron quirk that shapes this file: a session accepts exactly one
 * `webRequest.onBeforeRequest` listener. The tab manager already owns it, to
 * measure each page, so instead of letting Ghostery install its own (which
 * would silently replace ours) the tab manager calls `check()` from inside its
 * listener. One hook, two jobs: block the request and count it. That also
 * makes the tracker badge a real list match rather than a guess.
 *
 * Cosmetic filtering (hiding the empty boxes ads leave behind) and the CSP
 * rules some filters need run through Ghostery's own preload script and
 * header hook, which do not collide with anything of ours.
 */

import { readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";

import { ipcMain, type Session } from "electron";
import { ElectronBlocker, fromElectronDetails } from "@ghostery/adblocker-electron";
import { domainOf } from "@jasb/intent-engine";

/** How long a downloaded filter engine is trusted before it is refreshed. */
const ENGINE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const COSMETIC_CHANNELS = [
  "@ghostery/adblocker/inject-cosmetic-filters",
  "@ghostery/adblocker/is-mutation-observer-enabled",
] as const;

export interface AdblockSettings {
  enabled: boolean;
  /** Sites the user has paused blocking on, because something broke. */
  pausedDomains: string[];
  /**
   * Decline cookie pop-ups automatically. Optional because settings saved
   * before the feature existed lack it; absent means on.
   */
  cookiePopups?: boolean;
}

export interface CheckResult {
  cancel: boolean;
  redirectURL?: string;
  /** True when the request matched a filter list, blocked or not. */
  matched: boolean;
  /**
   * Hold the answer this long before cancelling. Non-zero only for a request
   * the page keeps retrying (see RetryTarpit).
   */
  delayMs: number;
}

/**
 * Slows down pages that retry a blocked request in a tight loop.
 *
 * Some ad scripts re-send a failed request immediately, forever. In Chrome
 * that is cheap; in Electron every attempt crosses into this process, and one
 * CNN ad config was measured at 83,000 attempts in 15 seconds, enough to
 * freeze the whole app. The retries are sequential (each waits for the
 * previous failure), so answering late throttles the loop itself: the first
 * few blocks are instant, then each repeat waits longer, up to two seconds.
 */
class RetryTarpit {
  static readonly WINDOW_MS = 5_000;
  static readonly FREE_REPEATS = 10;
  static readonly MAX_DELAY_MS = 2_000;
  static readonly MAX_KEYS = 2_000;

  #seen = new Map<string, { count: number; since: number }>();

  delayFor(key: string, now = Date.now()): number {
    let entry = this.#seen.get(key);
    if (!entry || now - entry.since > RetryTarpit.WINDOW_MS) {
      entry = { count: 0, since: now };
      this.#seen.delete(key);
      this.#seen.set(key, entry);
      if (this.#seen.size > RetryTarpit.MAX_KEYS) {
        this.#seen.delete(this.#seen.keys().next().value!);
      }
    }
    entry.count += 1;
    const excess = entry.count - RetryTarpit.FREE_REPEATS;
    if (excess <= 0) return 0;
    return Math.min(RetryTarpit.MAX_DELAY_MS, 50 * 2 ** Math.min(excess, 6));
  }
}

export class Adblock {
  #blocker: ElectronBlocker | undefined;
  #session: Session;
  #settings: AdblockSettings;
  #preloadId: string | undefined;
  #tarpit = new RetryTarpit();

  constructor(session: Session, settings: AdblockSettings) {
    this.#session = session;
    this.#settings = settings;
  }

  /**
   * Loads the filter engine. Until it resolves, `check()` lets everything
   * through: a slow first download must never stop pages from loading.
   */
  async load(cachePath: string): Promise<void> {
    // A stale cache is deleted rather than read, so the next call fetches
    // fresh lists. Ghostery's helper only knows "cached or not".
    try {
      const info = await stat(cachePath);
      if (Date.now() - info.mtimeMs > ENGINE_MAX_AGE_MS) await writeFile(cachePath, "");
    } catch {
      /* no cache yet */
    }

    this.#blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, {
      path: cachePath,
      read: async (path) => {
        const buffer = await readFile(path);
        // An empty file is our "expired" marker: make the helper refetch.
        if (buffer.length === 0) throw new Error("expired");
        return buffer;
      },
      write: async (path, buffer) => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, buffer);
      },
    });
    this.#applyCosmetics();
  }

  get ready(): boolean {
    return this.#blocker !== undefined;
  }

  get settings(): AdblockSettings {
    return { ...this.#settings, pausedDomains: [...this.#settings.pausedDomains] };
  }

  update(settings: AdblockSettings): void {
    this.#settings = settings;
    this.#applyCosmetics();
  }

  isPaused(domain: string | undefined): boolean {
    if (!domain) return false;
    return this.#settings.pausedDomains.some(
      (paused) => domain === paused || domain.endsWith(`.${paused}`),
    );
  }

  /**
   * Decides one request. `pageDomain` is the site in the tab, used for the
   * per-site pause; the request's own URL is matched against the lists.
   */
  check(details: Electron.OnBeforeRequestListenerDetails, pageDomain?: string): CheckResult {
    if (!this.#blocker) return { cancel: false, matched: false, delayMs: 0 };

    const request = fromElectronDetails(details);
    if (request.type === "other") request.guessTypeOfRequest();
    // The page the user asked for is never blocked, whatever a list says.
    if (request.isMainFrame()) return { cancel: false, matched: false, delayMs: 0 };

    const { match, redirect } = this.#blocker.match(request);
    const matched = Boolean(match || redirect);
    if (!matched || !this.#settings.enabled || this.isPaused(pageDomain)) {
      return { cancel: false, matched, delayMs: 0 };
    }
    // Some filters swap a script for a harmless stub instead of cancelling
    // it, so pages that expect the script to exist keep working.
    if (redirect) return { cancel: false, redirectURL: redirect.dataUrl, matched, delayMs: 0 };
    const delayMs = this.#tarpit.delayFor(`${details.webContentsId ?? 0} ${details.url}`);
    return { cancel: true, matched, delayMs };
  }

  #applyCosmetics(): void {
    const blocker = this.#blocker;
    if (!blocker) return;
    const want = this.#settings.enabled;

    if (want && this.#preloadId === undefined) {
      // Ghostery's preload asks the main process which elements to hide; on a
      // paused site we answer with nothing.
      this.#preloadId = this.#session.registerPreloadScript({
        type: "frame",
        filePath: preloadPath(),
      });
      ipcMain.handle(COSMETIC_CHANNELS[0], (event, url: string, msg) => {
        if (this.isPaused(domainOf(event.sender.getURL()) ?? domainOf(url))) return;
        return blocker.onInjectCosmeticFilters(event, url, msg);
      });
      ipcMain.handle(COSMETIC_CHANNELS[1], (event) => blocker.onIsMutationObserverEnabled(event));
      this.#session.webRequest.onHeadersReceived({ urls: ["<all_urls>"] }, (details, callback) =>
        blocker.onHeadersReceived(details, callback),
      );
    } else if (!want && this.#preloadId !== undefined) {
      this.#session.unregisterPreloadScript(this.#preloadId);
      this.#preloadId = undefined;
      for (const channel of COSMETIC_CHANNELS) ipcMain.removeHandler(channel);
      this.#session.webRequest.onHeadersReceived(null);
    }
  }
}

/**
 * Ghostery's preload file. It is a dependency of the blocker package, not of
 * ours, so resolve it from there, which is exactly what the library does.
 * Works in development and inside the packaged app's asar alike.
 */
function preloadPath(): string {
  const require = createRequire(import.meta.url);
  const blockerEntry = require.resolve("@ghostery/adblocker-electron");
  return createRequire(blockerEntry).resolve("@ghostery/adblocker-electron-preload");
}
