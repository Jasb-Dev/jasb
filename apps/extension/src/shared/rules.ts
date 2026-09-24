/**
 * Ranking rules, stored in `chrome.storage.local`.
 *
 * Deliberately *not* `chrome.storage.sync`: sync would push the user's block
 * and pin lists — a fairly precise portrait of their taste — through Google's
 * servers, which is the opposite of what this product promises.
 */

const KEY_BLOCKED = "jasb.blocked";
const KEY_PINNED = "jasb.pinned";
const KEY_BYOK = "jasb.byok";
const KEY_LICENSE = "jasb.license";

export interface Rules {
  blocked: string[];
  pinned: string[];
}

export async function loadRules(): Promise<Rules> {
  const stored = await chrome.storage.local.get([KEY_BLOCKED, KEY_PINNED]);
  return {
    blocked: asStringArray(stored[KEY_BLOCKED]),
    pinned: asStringArray(stored[KEY_PINNED]),
  };
}

export async function blockDomain(domain: string): Promise<void> {
  const rules = await loadRules();
  await chrome.storage.local.set({
    [KEY_BLOCKED]: unique([...rules.blocked, domain]),
    // Blocking and pinning the same domain is contradictory state; drop the pin.
    [KEY_PINNED]: rules.pinned.filter((d) => d !== domain),
  });
}

export async function unblockDomain(domain: string): Promise<void> {
  const rules = await loadRules();
  await chrome.storage.local.set({
    [KEY_BLOCKED]: rules.blocked.filter((d) => d !== domain),
  });
}

export async function pinDomain(domain: string): Promise<void> {
  const rules = await loadRules();
  await chrome.storage.local.set({
    [KEY_PINNED]: unique([...rules.pinned, domain]),
    [KEY_BLOCKED]: rules.blocked.filter((d) => d !== domain),
  });
}

export async function unpinDomain(domain: string): Promise<void> {
  const rules = await loadRules();
  await chrome.storage.local.set({
    [KEY_PINNED]: rules.pinned.filter((d) => d !== domain),
  });
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

/**
 * Extension storage is not encrypted at rest.
 *
 * Anyone with the profile directory can read a key stored here, so the settings
 * screen says so and recommends server mode for people who care. The desktop
 * build uses the OS keychain instead, which is the real answer.
 */
export async function loadByok(): Promise<ByokSettings> {
  const stored = await chrome.storage.local.get(KEY_BYOK);
  const value = stored[KEY_BYOK];
  return value && typeof value === "object" ? (value as ByokSettings) : {};
}

export async function saveByok(settings: ByokSettings): Promise<void> {
  await chrome.storage.local.set({ [KEY_BYOK]: settings });
}

/** A paid plan's key, sent with each request so the server applies the plan's quota. */
export async function loadLicense(): Promise<string> {
  const stored = await chrome.storage.local.get(KEY_LICENSE);
  const value = stored[KEY_LICENSE];
  return typeof value === "string" ? value : "";
}

export async function saveLicense(key: string): Promise<void> {
  await chrome.storage.local.set({ [KEY_LICENSE]: key.trim().toLowerCase() });
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
