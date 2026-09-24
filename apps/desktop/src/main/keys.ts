/**
 * BYOK key storage, through the OS keychain.
 *
 * Electron's `safeStorage` encrypts with a key held by macOS Keychain, Windows
 * DPAPI, or the Linux secret service. This is the one place the desktop build
 * is genuinely better than the extension, where storage is plaintext on disk —
 * and it is why the settings screen recommends the desktop app for people who
 * want to bring their own keys.
 *
 * Keys are write-only from the renderer's point of view: it can ask whether one
 * is set, never what it is.
 */

import { readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

import { app, safeStorage } from "electron";

import type { ByokSettings } from "../shared/ipc.ts";

const FIELDS = [
  "systemOneUrl",
  "systemOneModel",
  "systemOneApiKey",
  "llmProvider",
  "llmApiKey",
  "llmModel",
  "braveApiKey",
  "searxngUrl",
] as const satisfies readonly (keyof ByokSettings)[];

export class KeyVault {
  #path: string;
  #cache: ByokSettings | undefined;

  constructor(path = join(app.getPath("userData"), "keys.enc")) {
    this.#path = path;
  }

  /** True when the platform can actually encrypt. Linux without a keyring cannot. */
  get available(): boolean {
    return safeStorage.isEncryptionAvailable();
  }

  read(): ByokSettings {
    if (this.#cache) return this.#cache;
    if (!existsSync(this.#path)) return {};

    try {
      const blob = readFileSync(this.#path);
      const plain = safeStorage.decryptString(blob);
      this.#cache = JSON.parse(plain) as ByokSettings;
      return this.#cache;
    } catch {
      // A keychain entry the OS can no longer decrypt — a restored backup on a
      // different machine, or a changed login keychain. Treat it as absent and
      // let the user re-enter rather than crashing on every launch.
      return {};
    }
  }

  write(settings: ByokSettings): void {
    if (!this.available) {
      throw new Error(
        "This system has no secure storage available, so keys cannot be saved. " +
          "Use server mode, or run a local Ollama and SearxNG instead.",
      );
    }

    const cleaned: ByokSettings = {};
    for (const field of FIELDS) {
      const value = settings[field];
      if (typeof value === "string" && value.trim()) {
        (cleaned as Record<string, string>)[field] = value.trim();
      }
    }

    if (Object.keys(cleaned).length === 0) {
      this.clear();
      return;
    }

    writeFileSync(this.#path, safeStorage.encryptString(JSON.stringify(cleaned)), {
      mode: 0o600,
    });
    this.#cache = cleaned;
  }

  /** Which fields are set — never the values themselves. */
  status(): Record<keyof ByokSettings, boolean> {
    const settings = this.read();
    return Object.fromEntries(
      FIELDS.map((field) => [field, Boolean(settings[field])]),
    ) as Record<keyof ByokSettings, boolean>;
  }

  clear(): void {
    this.#cache = undefined;
    rmSync(this.#path, { force: true });
  }
}
