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

import { Adblock, type AdblockSettings } from "./adblock.ts";
import { buildEngine } from "./engine.ts";
import { QuotaExceeded, checkLicenseRemote, resolveRemote } from "./jasb-search.ts";
import { KeyVault } from "./keys.ts";
import { LocalStore } from "./store.ts";
import { CHROME_HEIGHT, TabManager } from "./tabs.ts";
import {
  CHANNELS,
  type AdblockState,
  type ByokSettings,
  type Favourite,
  type SearchSetup,
  type ShellState,
} from "../shared/ipc.ts";

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
let adblock: Adblock | undefined;

const ADBLOCK_KEY = "adblock";
/** On by default: a browser that promises clean pages should deliver them. */
const ADBLOCK_DEFAULT: AdblockSettings = { enabled: true, pausedDomains: [] };

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

  adblock = new Adblock(pageSession, store.setting(ADBLOCK_KEY, ADBLOCK_DEFAULT));
  // In the background: pages load normally until the lists are ready.
  adblock
    .load(join(app.getPath("userData"), "adblock-engine.bin"))
    .then(publishState)
    .catch((error: unknown) => {
      // Offline on first launch, or Ghostery's CDN unreachable. Browsing still
      // works; blocking starts on the next launch that can fetch the lists.
      console.warn("ad blocker unavailable:", error);
    });

  tabs = new TabManager({
    window,
    store,
    session: pageSession,
    adblock,
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

// --- Search routing -----------------------------------------------------------

const LICENSE_KEY = "license";
const DEVICE_KEY = "device";
const OWN_KEY_SEARCHES = "ownKeySearches";
const SUPPORT_DISMISSED = "supportNoteDismissed";
/** The support note appears once, after this many searches on the user's own keys. */
const SUPPORT_NOTE_AFTER = 100;

/** Last licence verdict, so Settings and the support note do not re-check every time. */
let licenseCheck: SearchSetup["check"];

function hasOwnKeys(): boolean {
  return Object.values(vault?.status() ?? {}).some(Boolean);
}

/**
 * A licence means Jasb Search. Without one, own keys mean local; with neither,
 * the monthly free allowance of Jasb Search beats the thin free-sources-only
 * local engine, so a first launch with nothing configured still searches well.
 */
function searchRoute(): SearchSetup["route"] {
  const license = store?.setting(LICENSE_KEY, "") ?? "";
  if (license) return "jasb";
  return hasOwnKeys() ? "own-keys" : "jasb";
}

function deviceToken(): string {
  let token = store?.setting(DEVICE_KEY, "") ?? "";
  if (!token && store) {
    token = crypto.randomUUID();
    store.setSetting(DEVICE_KEY, token);
  }
  return token;
}

function searchSetup(): SearchSetup {
  const route = searchRoute();
  const supporter = licenseCheck?.status === "valid" && licenseCheck.plan === "supporter";
  const searches = store?.setting(OWN_KEY_SEARCHES, 0) ?? 0;
  return {
    route,
    license: store?.setting(LICENSE_KEY, "") ?? "",
    ...(licenseCheck ? { check: licenseCheck } : {}),
    showSupportNote:
      route === "own-keys" &&
      !supporter &&
      searches >= SUPPORT_NOTE_AFTER &&
      !(store?.setting(SUPPORT_DISMISSED, false) ?? false),
  };
}

handle(CHANNELS.resolve, async (_event, query: string, options?: { refresh?: boolean }) => {
  if (!engine || !store) throw new Error("engine is not ready");

  const local = () =>
    engine!.resolve(query, {
      ...(options?.refresh ? { refresh: true } : {}),
      locale: app.getLocale(),
    });

  let result: ResolveResult;
  if (searchRoute() === "jasb") {
    const license = store.setting(LICENSE_KEY, "");
    try {
      result = await resolveRemote({
        query,
        ...(options?.refresh ? { refresh: true } : {}),
        locale: app.getLocale(),
        device: deviceToken(),
        ...(license ? { license } : {}),
        rules: store.rules(),
      });
    } catch (error) {
      // Out of searches: say so, and say what to do. Offline or server
      // trouble: fall back to the local engine, which always works.
      if (error instanceof QuotaExceeded && !hasOwnKeys()) throw error;
      result = await local();
    }
  } else {
    result = await local();
    if (result.kind === "cards") {
      store.setSetting(OWN_KEY_SEARCHES, store.setting(OWN_KEY_SEARCHES, 0) + 1);
    }
  }

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
  licenseCheck = undefined;
  adblock?.update(ADBLOCK_DEFAULT);
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

handle(CHANNELS.getSearchSetup, async () => {
  const license = store?.setting(LICENSE_KEY, "") ?? "";
  if (license && !licenseCheck) licenseCheck = await checkLicenseRemote(license);
  return searchSetup();
});

handle(CHANNELS.setLicense, async (_event, key: string) => {
  const trimmed = key.trim().toLowerCase();
  store?.setSetting(LICENSE_KEY, trimmed);
  licenseCheck = trimmed ? await checkLicenseRemote(trimmed) : undefined;
  return searchSetup();
});

handle(CHANNELS.dismissSupportNote, async () => {
  store?.setSetting(SUPPORT_DISMISSED, true);
});

// Only our own pages, never an arbitrary URL from the renderer.
handle(CHANNELS.openExternal, async (_event, url: string) => {
  if (/^https:\/\/(?:[a-z0-9-]+\.)?jasb\.dev(?:\/|$)/.test(url)) await shell.openExternal(url);
});

function adblockState(): AdblockState {
  const settings = adblock?.settings ?? ADBLOCK_DEFAULT;
  return { ...settings, ready: adblock?.ready ?? false };
}

function saveAdblock(settings: AdblockSettings): AdblockState {
  adblock?.update(settings);
  store?.setSetting(ADBLOCK_KEY, settings);
  publishState();
  return adblockState();
}

handle(CHANNELS.getAdblock, async () => adblockState());

handle(CHANNELS.setAdblockEnabled, async (_event, enabled: boolean) => {
  const state = saveAdblock({ ...adblockState(), enabled });
  tabs?.reloadActive();
  return state;
});

handle(CHANNELS.toggleAdblockForActiveSite, async () => {
  const domain = tabs?.activeDomain;
  const current = adblockState();
  if (!domain) return current;
  const paused = current.pausedDomains.includes(domain);
  const state = saveAdblock({
    enabled: current.enabled,
    pausedDomains: paused
      ? current.pausedDomains.filter((entry) => entry !== domain)
      : [...current.pausedDomains, domain].sort(),
  });
  tabs?.reloadActive();
  return state;
});

handle(CHANNELS.resumeAdblockFor, async (_event, domain: string) => {
  const current = adblockState();
  return saveAdblock({
    enabled: current.enabled,
    pausedDomains: current.pausedDomains.filter((entry) => entry !== domain),
  });
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
