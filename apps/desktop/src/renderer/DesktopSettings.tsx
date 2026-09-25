import { useEffect, useState } from "react";
import { Icon, IconButton, LicenseNotice } from "@jasb/ui";

import type { AdblockState, ByokSettings, SearchSetup } from "../shared/ipc.ts";

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

      <SearchGroup />

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

      <AdblockGroup />

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

/**
 * Where searches go, and the licence. Own keys are free and unlimited; Jasb
 * Search is for people who would rather not manage keys.
 */
function SearchGroup() {
  const [setup, setSetup] = useState<SearchSetup>();
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void window.jasb.getSearchSetup().then((value) => {
      setSetup(value);
      setDraft(value.license);
    });
  }, []);

  if (!setup) return null;

  const supporter = setup.check?.status === "valid" && setup.check.plan === "supporter";

  return (
    <section className="settings__group">
      <h3 className="settings__grouptitle">
        <Icon name="search" />
        <span>Search</span>
      </h3>
      <p className="settings__note">
        {setup.route === "own-keys"
          ? "Searches run on this Mac against the providers you set below: free and unlimited, and nothing passes through Jasb."
          : setup.license
            ? "Searches use Jasb Search on your licence. Your block and pin rules are applied on this Mac, after results arrive."
            : "Searches use Jasb Search's free allowance: 50 a month, no account. Add your own provider keys below to search free without limits, or a licence for more Jasb Search."}
      </p>
      <div className="settings__fields">
        <label className="field">
          <span className="field__label">
            Licence key
            <span className="field__hint">From checkout at jasb.dev. Works on every device.</span>
          </span>
          <div className="key-row">
            <input
              className="field__input"
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={draft}
              placeholder="jasb-xxxxx-xxxxx-xxxxx-xxxxx"
              onChange={(event) => setDraft(event.target.value)}
            />
            <button
              type="button"
              className="key-row__save"
              disabled={saving || draft.trim().toLowerCase() === setup.license}
              onClick={async () => {
                setSaving(true);
                setSetup(await window.jasb.setLicense(draft));
                setSaving(false);
              }}
            >
              {saving ? "Checking…" : "Save"}
            </button>
          </div>
        </label>
        {setup.check && <LicenseNotice check={setup.check} />}
        {!supporter && (
          <p className="settings__note">
            On your own keys Jasb is free for good. If it is useful, a{" "}
            <button
              type="button"
              className="link-button"
              onClick={() => void window.jasb.openExternal("https://jasb.dev/#pricing")}
            >
              one-time $19 Supporter licence
            </button>{" "}
            keeps it independent.
          </p>
        )}
      </div>
    </section>
  );
}

/**
 * Ad and tracker blocking: one switch, and the sites it is paused on. Pausing
 * happens from the shield in the toolbar, where the breakage is noticed; this
 * list is where it is undone.
 */
function AdblockGroup() {
  const [state, setState] = useState<AdblockState>();

  useEffect(() => {
    void window.jasb.getAdblock().then(setState);
  }, []);

  if (!state) return null;

  return (
    <section className="settings__group">
      <h3 className="settings__grouptitle">
        <Icon name="shield" />
        <span>Ads and trackers</span>
      </h3>
      <p className="settings__note">
        Pages load without ads or tracking scripts, using the same open filter lists as uBlock
        Origin and Ghostery (EasyList, EasyPrivacy), updated weekly. It runs inside the
        browser itself, so Chrome's extension limits don't apply. Nothing about the pages you
        visit is sent anywhere.
        {!state.ready && " The lists are still downloading; blocking starts in a moment."}
      </p>
      <div className="settings__fields">
        <label className="field field--inline">
          <input
            type="checkbox"
            checked={state.enabled}
            onChange={async (event) => setState(await window.jasb.setAdblockEnabled(event.target.checked))}
          />
          <span className="field__label">Block ads and trackers</span>
        </label>

        <div className="rules">
          <span className="label">
            <Icon name="block" size={13} /> Paused on
          </span>
          {state.pausedDomains.length === 0 ? (
            <p className="settings__note">
              No sites. If a page breaks, click the shield in the toolbar to pause blocking there.
            </p>
          ) : (
            <ul className="rules__list">
              {state.pausedDomains.map((domain) => (
                <li key={domain} className="rules__item">
                  <span className="mono">{domain}</span>
                  <IconButton
                    icon="close"
                    label={`Resume blocking on ${domain}`}
                    onClick={async () => setState(await window.jasb.resumeAdblockFor(domain))}
                    iconOnly
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
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
