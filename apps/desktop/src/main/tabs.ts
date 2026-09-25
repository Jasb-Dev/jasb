/**
 * Tabs, and the quality measurement that rides along with them.
 *
 * Each tab is a `WebContentsView` layered under the chrome. Pages are isolated
 * from the chrome renderer and from each other, and because every request
 * passes through our session we can count third-party requests for free — the
 * signal Kagi has to crawl the whole web to approximate.
 *
 * Nothing measured here is uploaded. It feeds this device's own ranking.
 */

import { BaseWindow, WebContentsView, type Session } from "electron";

import { domainOf } from "@jasb/intent-engine";

import type { Adblock } from "./adblock.ts";
import { groupByCompany } from "./tracker-companies.ts";
import type { LocalStore } from "./store.ts";
import type { SiteReport, TabState } from "../shared/ipc.ts";

/** Height reserved for the intent bar and tab strip. */
export const CHROME_HEIGHT = 96;

/** A visit shorter than this reads as "wrong page, went back". */
const QUICK_BACK_MS = 3_000;

interface Tab {
  id: number;
  view: WebContentsView;
  trackerCount: number;
  /** Requests the blocker stopped on this page load. */
  blockedCount: number;
  /** Hosts already counted for this page load, so one CDN counts once. */
  countedHosts: Set<string>;
  /** Blocked requests per host, for the shield panel. */
  blockedHosts: Map<string, number>;
  /** Third-party requests that were allowed to load, per host. */
  loadedHosts: Map<string, number>;
  /** Cookie consent pop-up handled on this page (CMP name), if any. */
  cookiePopup: string | undefined;
  navigationStartedAt: number;
  loadFinishedAt: number | undefined;
  currentDomain: string;
  title: string;
  favicon: string | undefined;
}

export class TabManager {
  #window: BaseWindow;
  #store: LocalStore;
  #session: Session;
  #adblock: Adblock | undefined;
  #onChange: () => void;

  #tabs = new Map<number, Tab>();
  #order: number[] = [];
  #activeId: number | undefined;
  #nextId = 1;
  #cardsVisible = true;
  /** Extra height above the page for a tip banner (0 when none is showing). */
  #bannerHeight = 0;
  /** Pending coalesced state update: counts change hundreds of times a page. */
  #changeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: {
    window: BaseWindow;
    store: LocalStore;
    session: Session;
    adblock?: Adblock;
    onChange: () => void;
  }) {
    this.#window = options.window;
    this.#store = options.store;
    this.#session = options.session;
    this.#adblock = options.adblock;
    this.#onChange = options.onChange;

    this.#installTrackerCounter();
  }

  get cardsVisible(): boolean {
    return this.#cardsVisible;
  }

  get activeId(): number | undefined {
    return this.#activeId;
  }

  states(): TabState[] {
    return this.#order.flatMap((id) => {
      const tab = this.#tabs.get(id);
      if (!tab) return [];
      const contents = tab.view.webContents;
      return [
        {
          id,
          title: tab.title || contents.getURL() || "New tab",
          url: contents.getURL(),
          loading: contents.isLoading(),
          canGoBack: contents.navigationHistory.canGoBack(),
          canGoForward: contents.navigationHistory.canGoForward(),
          trackerCount: tab.trackerCount,
          blockedCount: tab.blockedCount,
          blockedCompanies: groupByCompany(tab.blockedHosts)
            .filter((group) => group.known)
            .map((group) => group.name),
          adblockPaused: this.#adblock?.isPaused(tab.currentDomain) ?? false,
          ...(tab.favicon ? { favicon: tab.favicon } : {}),
        },
      ];
    });
  }

  /**
   * Opens a tab. A background tab loads without taking focus or hiding the
   * card grid, so several results can be opened in a row.
   */
  open(url?: string, options: { background?: boolean } = {}): number {
    const id = this.#nextId++;
    const view = new WebContentsView({
      webPreferences: {
        session: this.#session,
        // A page has no business reaching Node, the engine, or the keychain.
        // This product has no agent mode, so there is nothing to trade away.
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
      },
    });

    const tab: Tab = {
      id,
      view,
      trackerCount: 0,
      blockedCount: 0,
      countedHosts: new Set(),
      blockedHosts: new Map(),
      loadedHosts: new Map(),
      cookiePopup: undefined,
      navigationStartedAt: Date.now(),
      loadFinishedAt: undefined,
      currentDomain: "",
      title: "",
      favicon: undefined,
    };

    this.#wire(tab);
    this.#tabs.set(id, tab);
    this.#order.push(id);

    if (url) void view.webContents.loadURL(url);
    if (options.background && this.#activeId !== undefined) {
      this.#onChange();
    } else if (options.background) {
      // Nothing to stay on but the grid: remember this tab as the one a
      // click on "Results → tab" returns to, without showing it yet.
      this.#activeId = id;
      this.#onChange();
    } else {
      this.select(id);
    }
    return id;
  }

  select(id: number): void {
    const tab = this.#tabs.get(id);
    if (!tab) return;

    if (this.#activeId !== undefined && this.#activeId !== id) {
      const previous = this.#tabs.get(this.#activeId);
      if (previous) this.#window.contentView.removeChildView(previous.view);
    }

    this.#activeId = id;
    this.#cardsVisible = false;
    this.#window.contentView.addChildView(tab.view);
    this.layout();
    tab.view.webContents.focus();
    this.#onChange();
  }

  /**
   * Hides the web view so the card grid shows through.
   *
   * The chrome renderer fills the whole window and the tab view is layered on
   * top, so "show the grid" is literally removing the page from the stack —
   * the page keeps running and keeps its scroll position.
   */
  showCards(): void {
    if (this.#activeId !== undefined) {
      const tab = this.#tabs.get(this.#activeId);
      if (tab) this.#window.contentView.removeChildView(tab.view);
    }
    this.#cardsVisible = true;
    this.#onChange();
  }

  close(id: number): void {
    const tab = this.#tabs.get(id);
    if (!tab) return;

    this.#recordVisit(tab);
    this.#window.contentView.removeChildView(tab.view);
    tab.view.webContents.close();
    this.#tabs.delete(id);
    this.#order = this.#order.filter((tabId) => tabId !== id);

    if (this.#activeId === id) {
      const next = this.#order[this.#order.length - 1];
      if (next !== undefined) this.select(next);
      else {
        this.#activeId = undefined;
        this.showCards();
      }
    }
    this.#onChange();
  }

  /** Loads in the active tab, opening one if there is none. */
  navigate(url: string): void {
    if (this.#activeId === undefined) {
      this.open(url);
      return;
    }
    const tab = this.#tabs.get(this.#activeId);
    if (!tab) return;

    this.#recordVisit(tab);
    void tab.view.webContents.loadURL(url);
    this.select(tab.id);
  }

  goBack(): void {
    this.#active()?.view.webContents.navigationHistory.goBack();
  }

  goForward(): void {
    this.#active()?.view.webContents.navigationHistory.goForward();
  }

  reload(): void {
    this.#active()?.view.webContents.reload();
  }

  /** Keeps the active page sized to the window below the chrome. */
  layout(): void {
    const tab = this.#active();
    if (!tab) return;
    const { width, height } = this.#window.getContentBounds();
    const top = CHROME_HEIGHT + this.#bannerHeight;
    tab.view.setBounds({ x: 0, y: top, width, height: Math.max(0, height - top) });
  }

  /**
   * Pushes the page down to make room for a tip banner drawn by the chrome,
   * the way DuckDuckGo's onboarding tips sit between toolbar and page.
   */
  setBannerHeight(px: number): void {
    this.#bannerHeight = Math.max(0, Math.round(px));
    this.layout();
  }

  /**
   * Brings the page back in front of the chrome after an overlay (the shield
   * panel, the Fire confirmation) closes. No-op while the grid is showing.
   */
  raiseActive(): void {
    const tab = this.#active();
    if (!tab || this.#cardsVisible) return;
    this.#window.contentView.addChildView(tab.view);
    this.layout();
  }

  /** Closes every tab without recording visits: used by the Fire button. */
  burnAll(): void {
    for (const tab of this.#tabs.values()) {
      this.#window.contentView.removeChildView(tab.view);
      tab.view.webContents.close();
    }
    this.#tabs.clear();
    this.#order = [];
    this.#activeId = undefined;
    this.#cardsVisible = true;
    this.#onChange();
  }

  disposeAll(): void {
    for (const tab of this.#tabs.values()) {
      this.#recordVisit(tab);
      tab.view.webContents.close();
    }
    this.#tabs.clear();
    this.#order = [];
    this.#activeId = undefined;
  }

  #active(): Tab | undefined {
    return this.#activeId === undefined ? undefined : this.#tabs.get(this.#activeId);
  }

  #wire(tab: Tab): void {
    const contents = tab.view.webContents;

    contents.on("did-start-navigation", (event) => {
      if (!event.isMainFrame) return;
      // A new page means a new measurement window.
      this.#recordVisit(tab);
      tab.navigationStartedAt = Date.now();
      tab.loadFinishedAt = undefined;
      tab.trackerCount = 0;
      tab.blockedCount = 0;
      tab.blockedHosts.clear();
      tab.loadedHosts.clear();
      tab.cookiePopup = undefined;
      tab.countedHosts.clear();
      tab.currentDomain = domainOf(event.url);
      this.#onChange();
    });

    contents.on("did-finish-load", () => {
      tab.loadFinishedAt = Date.now();
      void this.#detectPaywall(tab);
      this.#onChange();
    });

    contents.on("page-title-updated", (_event, title) => {
      tab.title = title;
      this.#onChange();
    });

    contents.on("page-favicon-updated", (_event, favicons) => {
      tab.favicon = favicons[0];
      this.#onChange();
    });

    contents.on("did-fail-load", () => this.#onChange());

    // Links that want a new window get a new tab instead — this browser has no
    // popups, and a target=_blank should not escape the tab model.
    contents.setWindowOpenHandler(({ url }) => {
      this.open(url);
      return { action: "deny" };
    });
  }

  /**
   * The session's single request hook: blocks and measures in one place.
   *
   * Electron allows one `onBeforeRequest` listener per session, so the ad
   * blocker is consulted from here rather than installing its own.
   *
   * The tracker count is the number of distinct hosts on the page that match
   * a filter list, whether or not blocking is on for this site, so a paused
   * site still reports honestly. Before the lists have loaded (the first
   * seconds of the very first launch) it falls back to counting third-party
   * hosts, a rougher proxy.
   */
  #installTrackerCounter(): void {
    this.#session.webRequest.onBeforeRequest((details, callback) => {
      const tab = [...this.#tabs.values()].find(
        (candidate) => candidate.view.webContents.id === details.webContentsId,
      );
      const verdict = this.#adblock?.check(details, tab?.currentDomain);

      if (tab && tab.currentDomain) {
        const requestDomain = domainOf(details.url);
        const thirdParty =
          requestDomain &&
          requestDomain !== tab.currentDomain &&
          !requestDomain.endsWith(`.${tab.currentDomain}`);
        const countsAsTracker = this.#adblock?.ready ? verdict?.matched : thirdParty;

        if (requestDomain && countsAsTracker && !tab.countedHosts.has(requestDomain)) {
          tab.countedHosts.add(requestDomain);
          tab.trackerCount += 1;
          this.#onChange();
        }
        const stopped = Boolean(verdict?.cancel || verdict?.redirectURL);
        // A retry loop would otherwise inflate the badge into the thousands.
        if (stopped && !verdict?.delayMs) {
          tab.blockedCount += 1;
          this.#changeSoon();
          if (requestDomain) {
            tab.blockedHosts.set(requestDomain, (tab.blockedHosts.get(requestDomain) ?? 0) + 1);
          }
        } else if (!stopped && thirdParty && requestDomain) {
          tab.loadedHosts.set(requestDomain, (tab.loadedHosts.get(requestDomain) ?? 0) + 1);
        }
      }

      if (verdict?.redirectURL) callback({ redirectURL: verdict.redirectURL });
      else if (verdict?.cancel && verdict.delayMs > 0) {
        setTimeout(() => callback({ cancel: true }), verdict.delayMs);
      } else callback({ cancel: verdict?.cancel ?? false });
    });
  }

  /** Publishes state at most every 400 ms while counters are moving. */
  #changeSoon(): void {
    if (this.#changeTimer) return;
    this.#changeTimer = setTimeout(() => {
      this.#changeTimer = undefined;
      this.#onChange();
    }, 400);
  }

  /** What the shield panel shows for the active tab. */
  siteReport(): SiteReport | undefined {
    const tab = this.#active();
    if (!tab || !tab.currentDomain) return undefined;
    const url = tab.view.webContents.getURL();
    return {
      domain: tab.currentDomain,
      secure: url.startsWith("https:"),
      paused: this.#adblock?.isPaused(tab.currentDomain) ?? false,
      blockedCount: tab.blockedCount,
      blocked: groupByCompany(tab.blockedHosts),
      loaded: groupByCompany(tab.loadedHosts),
      ...(tab.cookiePopup ? { cookiePopup: tab.cookiePopup } : {}),
    };
  }

  /** Records that a cookie pop-up was answered on the page in `webContentsId`. */
  noteCookiePopup(webContentsId: number, cmp: string): void {
    const tab = [...this.#tabs.values()].find((candidate) => candidate.view.webContents.id === webContentsId);
    if (!tab) return;
    tab.cookiePopup = cmp;
    this.#onChange();
  }

  /** Reloads the active tab, e.g. after blocking was paused for its site. */
  reloadActive(): void {
    const tab = this.#activeId === undefined ? undefined : this.#tabs.get(this.#activeId);
    tab?.view.webContents.reload();
  }

  /** The site in the active tab, for "pause blocking on this site". */
  get activeDomain(): string | undefined {
    const tab = this.#activeId === undefined ? undefined : this.#tabs.get(this.#activeId);
    return tab?.currentDomain || undefined;
  }

  /** Writes the finished measurement into the local quality table. */
  #recordVisit(tab: Tab): void {
    if (!tab.currentDomain || tab.loadFinishedAt === undefined) return;

    const loadMs = tab.loadFinishedAt - tab.navigationStartedAt;
    const dwellMs = Date.now() - tab.loadFinishedAt;

    this.#store.recordVisit(tab.currentDomain, {
      trackers: tab.trackerCount,
      loadMs,
      quickBack: dwellMs < QUICK_BACK_MS,
    });
  }

  /**
   * Looks for a paywall or login wall.
   *
   * Deliberately crude and deliberately read-only: a short script that reads
   * body text. Page content is never fed to a model — that is the injection
   * surface this product exists without.
   */
  async #detectPaywall(tab: Tab): Promise<void> {
    if (!tab.currentDomain) return;
    try {
      const paywalled = await tab.view.webContents.executeJavaScript(
        `(() => {
           const text = (document.body?.innerText ?? "").slice(0, 4000).toLowerCase();
           return /subscribe to (?:read|continue)|already a (?:subscriber|member)|this article is for subscribers|create a free account to (?:read|continue)/.test(text);
         })()`,
        true,
      );
      if (typeof paywalled === "boolean") {
        this.#store.markPaywall(tab.currentDomain, paywalled);
      }
    } catch {
      // A page that blocks script evaluation simply yields no signal.
    }
  }
}
