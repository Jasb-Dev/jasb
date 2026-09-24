/**
 * The contract between the chrome renderer and the main process.
 *
 * Shared by both sides so a rename breaks the build rather than the app. The
 * renderer has no Node access at all — every capability it needs is a named
 * channel here, which is what keeps a hostile page from reaching the engine,
 * the database or the keychain.
 */

import type { Card, ResolveResult } from "@jasb/intent-engine";

export interface TabState {
  id: number;
  title: string;
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Third-party requests counted on this page so far. */
  trackerCount: number;
  favicon?: string;
}

export interface ShellState {
  tabs: TabState[];
  activeTabId: number | undefined;
  /** True when the card grid is showing instead of a web page. */
  showingCards: boolean;
}

export interface Rules {
  blocked: string[];
  pinned: string[];
}

export interface ByokSettings {
  systemOneUrl?: string;
  systemOneModel?: string;
  systemOneApiKey?: string;
  llmProvider?: "anthropic" | "openai" | "openrouter" | "gemini" | "ollama";
  llmApiKey?: string;
  llmModel?: string;
  braveApiKey?: string;
  searxngUrl?: string;
}

export interface HistoryEntry {
  query: string;
  at: number;
}

export interface Favourite {
  url: string;
  title: string;
  domain: string;
  at: number;
}

/** Everything the renderer may ask the main process to do. */
export interface DesktopApi {
  resolve(query: string, options?: { refresh?: boolean }): Promise<ResolveResult>;

  openCard(card: Card): Promise<void>;
  navigate(url: string): Promise<void>;

  newTab(url?: string): Promise<number>;
  closeTab(id: number): Promise<void>;
  selectTab(id: number): Promise<void>;
  goBack(): Promise<void>;
  goForward(): Promise<void>;
  reload(): Promise<void>;
  /** Hides the web view so the card grid is visible again. */
  showCards(): Promise<void>;

  getRules(): Promise<Rules>;
  block(domain: string): Promise<void>;
  unblock(domain: string): Promise<void>;
  pin(domain: string): Promise<void>;
  unpin(domain: string): Promise<void>;

  getHistory(limit?: number): Promise<HistoryEntry[]>;
  getFavourites(): Promise<Favourite[]>;
  toggleFavourite(entry: Omit<Favourite, "at">): Promise<boolean>;
  clearAllData(): Promise<void>;

  /** Keys are written through the OS keychain; the renderer never sees them back. */
  getByokStatus(): Promise<Record<keyof ByokSettings, boolean>>;
  setByok(settings: ByokSettings): Promise<void>;

  onShellState(listener: (state: ShellState) => void): () => void;
}

export const CHANNELS = {
  resolve: "jasb:resolve",
  openCard: "jasb:open-card",
  navigate: "jasb:navigate",
  newTab: "jasb:new-tab",
  closeTab: "jasb:close-tab",
  selectTab: "jasb:select-tab",
  goBack: "jasb:go-back",
  goForward: "jasb:go-forward",
  reload: "jasb:reload",
  showCards: "jasb:show-cards",
  getRules: "jasb:get-rules",
  block: "jasb:block",
  unblock: "jasb:unblock",
  pin: "jasb:pin",
  unpin: "jasb:unpin",
  getHistory: "jasb:get-history",
  getFavourites: "jasb:get-favourites",
  toggleFavourite: "jasb:toggle-favourite",
  clearAllData: "jasb:clear-all-data",
  getByokStatus: "jasb:get-byok-status",
  setByok: "jasb:set-byok",
  shellState: "jasb:shell-state",
} as const;
