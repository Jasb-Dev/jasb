import { useEffect, useState } from "react";
import { Icon, IconButton } from "@jasb/ui";

import type { ByokSettings } from "../shared/ipc.ts";

/**
 * Desktop settings.
 *
 * The important difference from the web and extension versions: keys go into
 * the OS keychain and cannot be read back. The form shows whether a field is
 * set, never what it holds — so a screenshot of this screen leaks nothing.
 */
export function DesktopSettings({ onClose }: { onClose(): void }) {
  const [status, setStatus] = useState<Record<string, boolean>>({});
  const [draft, setDraft] = useState<ByokSettings>({});
  const [message, setMessage] = useState<string>();

  useEffect(() => {
    void window.jasb.getByokStatus().then(setStatus);
  }, []);

  async function save() {
    try {
      await window.jasb.setByok(draft);
      setStatus(await window.jasb.getByokStatus());
      setDraft({});
      setMessage("Saved to this Mac's keychain.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save keys.");
    }
  }

  return (
    <section className="settings">
      <header className="settings__head">
        <h2 className="settings__title">Settings</h2>
        <IconButton icon="close" label="Close" onClick={onClose} iconOnly />
      </header>

      <section className="settings__group">
        <h3 className="settings__grouptitle">
          <Icon name="lock" />
          <span>Your providers</span>
        </h3>
        <p className="settings__note">
          With these set, searches go from this machine straight to the providers you chose —
          nothing passes through our servers. Values are encrypted by the system keychain and
          cannot be read back by this window.
        </p>

        <div className="settings__fields">
          <KeyField
            label="Decision model URL"
            hint="A self-hosted System One server: Kev, CLM, Von or Decider. All Apache-2.0 and all speak the same protocol."
            field="systemOneUrl"
            set={status.systemOneUrl ?? false}
            draft={draft}
            onChange={setDraft}
            placeholder="http://127.0.0.1:8900"
            secret={false}
          />
          <KeyField
            label="Decision model name"
            field="systemOneModel"
            set={status.systemOneModel ?? false}
            draft={draft}
            onChange={setDraft}
            placeholder="kev-9b"
            secret={false}
          />

          <label className="field">
            <span className="field__label">Language model</span>
            <select
              className="field__input"
              value={draft.llmProvider ?? "anthropic"}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  llmProvider: event.target.value as ByokSettings["llmProvider"],
                })
              }
            >
              <option value="anthropic">Anthropic</option>
              <option value="openai">OpenAI</option>
              <option value="openrouter">OpenRouter</option>
              <option value="gemini">Google Gemini</option>
              <option value="ollama">Ollama (fully local)</option>
            </select>
          </label>

          <KeyField
            label="Language model key"
            field="llmApiKey"
            set={status.llmApiKey ?? false}
            draft={draft}
            onChange={setDraft}
            placeholder={draft.llmProvider === "ollama" ? "not needed for Ollama" : "sk-…"}
          />
          <KeyField
            label="Language model name"
            field="llmModel"
            set={status.llmModel ?? false}
            draft={draft}
            onChange={setDraft}
            placeholder="claude-opus-5"
            secret={false}
          />
          <KeyField
            label="Brave Search key"
            field="braveApiKey"
            set={status.braveApiKey ?? false}
            draft={draft}
            onChange={setDraft}
            placeholder="BSA…"
          />
          <KeyField
            label="SearxNG instance"
            hint="Free and unlimited once self-hosted. Needs the JSON format enabled."
            field="searxngUrl"
            set={status.searxngUrl ?? false}
            draft={draft}
            onChange={setDraft}
            placeholder="http://127.0.0.1:8888"
            secret={false}
          />
        </div>

        <IconButton
          icon="check"
          label="Save to keychain"
          onClick={save}
          className="settings__save"
        />
        {message && (
          <p className="settings__ok">
            <Icon name="check" />
            <span>{message}</span>
          </p>
        )}
      </section>

      <section className="settings__group">
        <h3 className="settings__grouptitle">
          <Icon name="trash" />
          <span>Your data</span>
        </h3>
        <p className="settings__note">
          History, favourites, ranking rules, the search cache and every page-quality
          measurement live in one SQLite file on this machine.
        </p>
        <button
          type="button"
          className="settings__danger"
          onClick={async () => {
            await window.jasb.clearAllData();
            setStatus(await window.jasb.getByokStatus());
            setMessage("Everything erased.");
          }}
        >
          <Icon name="trash" />
          <span>Erase everything, including saved keys</span>
        </button>
      </section>
    </section>
  );
}

function KeyField({
  label,
  hint,
  field,
  set,
  draft,
  onChange,
  placeholder,
  secret = true,
}: {
  label: string;
  hint?: string;
  field: keyof ByokSettings;
  /** Whether a value is already stored. The value itself is never returned. */
  set: boolean;
  draft: ByokSettings;
  onChange(draft: ByokSettings): void;
  placeholder: string;
  secret?: boolean;
}) {
  return (
    <label className="field">
      <span className="field__label">
        <span>
          {label}
          {set && (
            <span className="badge badge--signal" style={{ marginInlineStart: "var(--space-2)" }}>
              Set
            </span>
          )}
        </span>
        {hint && <span className="field__hint">{hint}</span>}
      </span>
      <input
        className="field__input"
        type={secret ? "password" : "text"}
        autoComplete="off"
        spellCheck={false}
        value={(draft[field] as string | undefined) ?? ""}
        placeholder={set ? "•••••••• — type to replace" : placeholder}
        onChange={(event) => onChange({ ...draft, [field]: event.target.value })}
      />
    </label>
  );
}
