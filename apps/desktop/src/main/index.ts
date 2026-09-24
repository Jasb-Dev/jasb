/**
 * Main process.
 *
 * Owns the window, the tabs, the database, the keychain and the engine. The
 * renderer owns nothing but pixels — every capability crosses an explicit IPC
 * channel, so a compromised page cannot reach anything that matters.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  BaseWindow,
  WebContentsView,
  app,
  ipcMain,
  session,
  shell,
  type IpcMainInvokeEvent,
} from "electron";

import type { Card, IntentEngine, ResolveResult } from "@jasb/intent-engine";

import { buildEngine } from "./engine.ts";
import { KeyVault } from "./keys.ts";
import { LocalStore } from "./store.ts";
import { CHROME_HEIGHT, TabManager } from "./tabs.ts";
import { CHANNELS, type ByokSettings, type Favourite, type ShellState } from "../shared/ipc.ts";

// Without this, `app.getPath("userData")` is derived from the package name and
// the database lands in a literal "@jasb/desktop" directory. Set before any path
// lookup, which means before the first `LocalStore`.
app.setName("Jasb");

const here = dirname(fileURLToPath(import.meta.url));
const RENDERER_DIST = join(here, "../renderer");

let window: BaseWindow | undefined;
let chrome: WebContentsView | undefined;
let tabs: TabManager | undefined;
let store: LocalStore | undefined;
let vault: KeyVault | undefined;
let engine: IntentEngine | undefined;

function publishState(): void {
  if (!chrome || !tabs) return;
  const state: ShellState = {
    tabs: tabs.states(),
    activeTabId: tabs.activeId,
    showingCards: tabs.cardsVisible,
  };
  chrome.webContents.send(CHANNELS.shellState, state);
}

function createWindow(): void {
  store = new LocalStore();
  store.pruneCache();
  vault = new KeyVault();
  engine = buildEngine(vault, store);

  window = new BaseWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 480,
    title: "Jasb",
    // A quiet frame: the product's whole claim is that the browser gets out of
    // the way, so the traffic lights sit inside our own chrome.
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    backgroundColor: "#f1f2ee",
  });

  chrome = new WebContentsView({
    webPreferences: {
      // Electron requires the `.mjs` extension for an ESM preload script.
      preload: join(here, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  window.contentView.addChildView(chrome);

  // Pages get their own session, separate from the chrome, so cookies set by a
  // site can never be read by our own UI.
  const pageSession = session.fromPartition("persist:pages");

  tabs = new TabManager({
    window,
    store,
    session: pageSession,
    onChange: publishState,
  });

  const layout = () => {
    if (!window || !chrome) return;
    const { width, height } = window.getContentBounds();
    chrome.setBounds({ x: 0, y: 0, width, height });
    tabs?.layout();
  };

  window.on("resize", layout);
  layout();

  const devServer = process.env.VITE_DEV_SERVER_URL;
  void (devServer
    ? chrome.webContents.loadURL(devServer)
    : chrome.webContents.loadFile(join(RENDERER_DIST, "index.html")));

  chrome.webContents.on("did-finish-load", publishState);

  // Our own UI must never navigate away from itself, and a link in it opens in
  // the user's default browser rather than replacing the chrome.
  chrome.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  window.on("closed", () => {
    tabs?.disposeAll();
    store?.close();
    window = undefined;
    chrome = undefined;
    tabs = undefined;
  });
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function handle<T>(channel: string, fn: (event: IpcMainInvokeEvent, ...args: never[]) => T): void {
  ipcMain.handle(channel, fn as never);
}

handle(CHANNELS.resolve, async (_event, query: string, options?: { refresh?: boolean }) => {
  if (!engine || !store) throw new Error("engine is not ready");

  const result: ResolveResult = await engine.resolve(query, {
    ...(options?.refresh ? { refresh: true } : {}),
    locale: app.getLocale(),
  });

  if (result.kind === "cards" && result.cards.length > 0) {
    store.recordSearch(query);
  }
  // A URL, bang or navigation hit goes straight to the active tab — the
  // "zero latency" promise only holds if the shell acts on it immediately.
  if (result.kind === "navigate") {
    tabs?.navigate(result.url);
  }
  return result;
});

handle(CHANNELS.openCard, async (_event, card: Card) => {
  tabs?.navigate(card.url);
});

handle(CHANNELS.navigate, async (_event, url: string) => {
  tabs?.navigate(url);
});

handle(CHANNELS.newTab, async (_event, url?: string) => tabs?.open(url) ?? -1);
handle(CHANNELS.closeTab, async (_event, id: number) => tabs?.close(id));
handle(CHANNELS.selectTab, async (_event, id: number) => tabs?.select(id));
handle(CHANNELS.goBack, async () => tabs?.goBack());
handle(CHANNELS.goForward, async () => tabs?.goForward());
handle(CHANNELS.reload, async () => tabs?.reload());
handle(CHANNELS.showCards, async () => tabs?.showCards());

handle(CHANNELS.getRules, async () => store?.rules() ?? { blocked: [], pinned: [] });

handle(CHANNELS.block, async (_event, domain: string) => {
  await store?.preferenceStore().block(domain);
});
handle(CHANNELS.unblock, async (_event, domain: string) => {
  await store?.preferenceStore().unblock(domain);
});
handle(CHANNELS.pin, async (_event, domain: string) => {
  await store?.preferenceStore().pin(domain);
});
handle(CHANNELS.unpin, async (_event, domain: string) => {
  await store?.preferenceStore().unpin(domain);
});

handle(CHANNELS.getHistory, async (_event, limit?: number) => store?.history(limit) ?? []);
handle(CHANNELS.getFavourites, async () => store?.favourites() ?? []);
handle(CHANNELS.toggleFavourite, async (_event, entry: Omit<Favourite, "at">) =>
  store?.toggleFavourite(entry) ?? false,
);

handle(CHANNELS.clearAllData, async () => {
  store?.clearAll();
  vault?.clear();
  // Rebuild the engine so the cleared cache and keys take effect immediately
  // rather than after a restart.
  if (vault && store) engine = buildEngine(vault, store);
});

handle(CHANNELS.getByokStatus, async () => vault?.status() ?? {});
handle(CHANNELS.setByok, async (_event, settings: ByokSettings) => {
  vault?.write(settings);
  if (vault && store) engine = buildEngine(vault, store);
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

// A second launch focuses the existing window instead of opening a rival one
// that would fight over the same SQLite file.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    window?.focus();
  });

  void app.whenReady().then(() => {
    createWindow();

    app.on("activate", () => {
      if (!window) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}

export { CHROME_HEIGHT };
