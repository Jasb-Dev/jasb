/**
 * First-run setup: the steps DuckDuckGo's onboarding has shown work, with
 * nothing forced. Each is a single call the welcome screen can make.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { app } from "electron";

import type { Favourite } from "../shared/ipc.ts";

interface BookmarkNode {
  type?: "url" | "folder";
  name?: string;
  url?: string;
  children?: BookmarkNode[];
}

/** Chromium browsers people are likely switching from, in order of preference. */
function bookmarkFiles(): { browser: string; path: string }[] {
  const home = homedir();
  const profiles: Record<string, string> =
    process.platform === "darwin"
      ? {
          Chrome: join(home, "Library/Application Support/Google/Chrome/Default/Bookmarks"),
          Brave: join(home, "Library/Application Support/BraveSoftware/Brave-Browser/Default/Bookmarks"),
          Edge: join(home, "Library/Application Support/Microsoft Edge/Default/Bookmarks"),
          Arc: join(home, "Library/Application Support/Arc/User Data/Default/Bookmarks"),
        }
      : process.platform === "win32"
        ? {
            Chrome: join(process.env.LOCALAPPDATA ?? "", "Google/Chrome/User Data/Default/Bookmarks"),
            Brave: join(process.env.LOCALAPPDATA ?? "", "BraveSoftware/Brave-Browser/User Data/Default/Bookmarks"),
            Edge: join(process.env.LOCALAPPDATA ?? "", "Microsoft/Edge/User Data/Default/Bookmarks"),
          }
        : {
            Chrome: join(home, ".config/google-chrome/Default/Bookmarks"),
            Chromium: join(home, ".config/chromium/Default/Bookmarks"),
            Brave: join(home, ".config/BraveSoftware/Brave-Browser/Default/Bookmarks"),
          };
  return Object.entries(profiles)
    .filter(([, path]) => existsSync(path))
    .map(([browser, path]) => ({ browser, path }));
}

/** Which browsers we could import from, for the button label. */
export function importableBrowsers(): string[] {
  return bookmarkFiles().map((file) => file.browser);
}

/**
 * Reads a Chromium bookmarks file. Read-only: we never touch the other
 * browser's data, and passwords are out of scope (use a password manager).
 */
export function readBookmarks(browser?: string): Omit<Favourite, "at">[] {
  const file = bookmarkFiles().find((candidate) => !browser || candidate.browser === browser);
  if (!file) return [];
  const json = JSON.parse(readFileSync(file.path, "utf8")) as {
    roots?: Record<string, BookmarkNode>;
  };
  const out: Omit<Favourite, "at">[] = [];
  const walk = (node: BookmarkNode | undefined) => {
    if (!node) return;
    if (node.type === "url" && node.url && /^https?:/.test(node.url)) {
      let domain = "";
      try {
        domain = new URL(node.url).hostname.replace(/^www\./, "");
      } catch {
        return;
      }
      out.push({ url: node.url, title: node.name || domain, domain });
    }
    node.children?.forEach(walk);
  };
  Object.values(json.roots ?? {}).forEach(walk);
  return out;
}

export function isDefaultBrowser(): boolean {
  return app.isDefaultProtocolClient("https") && app.isDefaultProtocolClient("http");
}

/**
 * Asks the OS to make Jasb the default browser. macOS and Windows show their
 * own confirmation; we only start the request. A development build is not a
 * sensible default browser, so this is a no-op outside a packaged app.
 */
export function makeDefaultBrowser(): boolean {
  if (!app.isPackaged) return false;
  const http = app.setAsDefaultProtocolClient("http");
  const https = app.setAsDefaultProtocolClient("https");
  return http && https;
}

export function openAtLogin(): boolean {
  return app.getLoginItemSettings().openAtLogin;
}

export function setOpenAtLogin(enabled: boolean): void {
  app.setLoginItemSettings({ openAtLogin: enabled });
}
