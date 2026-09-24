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

import type { LocalStore } from "./store.ts";
import type { TabState } from "../shared/ipc.ts";

/** Height reserved for the intent bar and tab strip. */
export const CHROME_HEIGHT = 96;

/** A visit shorter than this reads as "wrong page, went back". */
const QUICK_BACK_MS = 3_000;

interface Tab {
  id: number;
  view: WebContentsView;
  trackerCount: number;
  /** Hosts already counted for this page load, so one CDN counts once. */
  countedHosts: Set<string>;
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
  #onChange: () => void;

  #tabs = new Map<number, Tab>();
  #order: number[] = [];
  #activeId: number | undefined;
  #nextId = 1;
  #cardsVisible = true;

  constructor(options: {
    window: BaseWindow;
    store: LocalStore;
    session: Session;
    onChange: () => void;
  }) {
    this.#window = options.window;
    this.#store = options.store;
    this.#session = options.session;
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
          ...(tab.favicon ? { favicon: tab.favicon } : {}),
        },
      ];
    });
  }

  open(url?: string): number {
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
      countedHosts: new Set(),
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
    this.select(id);
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
    tab.view.setBounds({
      x: 0,
      y: CHROME_HEIGHT,
      width,
      height: Math.max(0, height - CHROME_HEIGHT),
    });
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
   * Counts third-party requests per tab.
   *
   * "Third party" here means a different registrable domain from the page
   * itself, counted once per host. That is a rough proxy for a tracker rather
   * than a blocklist match — but it is measured on the page the user actually
   * loaded, today, which is worth more than a stale list.
   */
  #installTrackerCounter(): void {
    this.#session.webRequest.onBeforeRequest((details, callback) => {
      const tab = [...this.#tabs.values()].find(
        (candidate) => candidate.view.webContents.id === details.webContentsId,
      );

      if (tab && tab.currentDomain) {
        const requestDomain = domainOf(details.url);
        if (
          requestDomain &&
          requestDomain !== tab.currentDomain &&
          !requestDomain.endsWith(`.${tab.currentDomain}`) &&
          !tab.countedHosts.has(requestDomain)
        ) {
          tab.countedHosts.add(requestDomain);
          tab.trackerCount += 1;
        }
      }

      callback({ cancel: false });
    });
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
