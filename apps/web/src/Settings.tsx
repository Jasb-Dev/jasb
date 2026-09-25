import { useEffect, useState } from "react";
import { SYSTEM_ONE_PRESETS } from "@jasb/intent-engine";
import { Icon, IconButton, LicenseNotice, checkLicense, type LicenseCheck } from "@jasb/ui";

import { serverUrl } from "./client.ts";
import {
  clearEverything,
  createPreferenceStore,
  readByok,
  readLicense,
  writeByok,
  writeLicense,
  type ByokSettings,
} from "./storage.ts";

const preferences = createPreferenceStore();

/**
 * Settings.
 *
 * In the order that matters: your plan, where your queries go, what this
 * browser has learned about your taste, and the one button that erases it all.
 * Each field says plainly where its value travels — a privacy claim that hides
 * its exceptions is worse than no claim.
 */
export function Settings({ onClose }: { onClose(): void }) {
  const [byok, setByok] = useState<ByokSettings>(() => readByok());
  const [rules, setRules] = useState(() => preferences.snapshot());
  const [saved, setSaved] = useState(false);

  function update(patch: Partial<ByokSettings>) {
    const next = { ...byok, ...patch };
    setByok(next);
    writeByok(next);
    setSaved(true);
  }

  return (
    <section className="settings">
      <header className="settings__head">
        <h2 className="settings__title">Settings</h2>
        <IconButton icon="close" label="Close" onClick={onClose} iconOnly />
      </header>

      <LicenseGroup />

      <Group
        icon="lock"
        title="Where your searches go"
        note={
          `By default queries go to ${serverUrl}, which keeps no logs and no IP addresses — ` +
          "only a hash of the query mapped to the resulting sites. Point the fields below at " +
          "your own providers and they are used for that single request and never stored."
        }
      >
        <Field
          label="Decision model URL"
          hint="A self-hosted System One server. Jev is closed, so the open reproductions are the practical choice."
          value={byok.systemOneUrl ?? ""}
          placeholder="http://127.0.0.1:8900"
          secret={false}
          onChange={(value) => update({ systemOneUrl: value })}
        />

        <Select
          label="Model"
          value={byok.systemOneModel ?? ""}
          onChange={(value) => update({ systemOneModel: value })}
          options={[
            { value: "", label: "Server default" },
            ...Object.entries(SYSTEM_ONE_PRESETS)
              .filter(([, preset]) => preset.open)
              .map(([, preset]) => ({ value: preset.model, label: preset.label })),
          ]}
        />

        <Select
          label="Language model"
          value={byok.llmProvider ?? "anthropic"}
          onChange={(value) => update({ llmProvider: value as ByokSettings["llmProvider"] })}
          options={[
            { value: "anthropic", label: "Anthropic" },
            { value: "openai", label: "OpenAI" },
            { value: "openrouter", label: "OpenRouter" },
            { value: "gemini", label: "Google Gemini" },
            { value: "ollama", label: "Ollama (local)" },
          ]}
        />

        <Field
          label="Language model key"
          value={byok.llmApiKey ?? ""}
          placeholder={byok.llmProvider === "ollama" ? "not needed for Ollama" : "sk-…"}
          onChange={(value) => update({ llmApiKey: value })}
        />
        <Field
          label="Brave Search key"
          value={byok.braveApiKey ?? ""}
          placeholder="BSA…"
          onChange={(value) => update({ braveApiKey: value })}
        />
        <Field
          label="SearxNG instance"
          hint="Free and unlimited once you host it. Needs the JSON format enabled."
          value={byok.searxngUrl ?? ""}
          placeholder="http://127.0.0.1:8888"
          secret={false}
          onChange={(value) => update({ searxngUrl: value })}
        />

        <p className="settings__warn">
          <Icon name="shield" />
          <span>
            This browser stores keys in ordinary browser storage, which is not encrypted.
            For real key safety use the desktop app, which puts them in the system keychain.
          </span>
        </p>

        {saved && (
          <p className="settings__ok">
            <Icon name="check" />
            <span>Saved to this browser.</span>
          </p>
        )}
      </Group>

      <Group
        icon="pin"
        title="Your ranking rules"
        note="Applied on this device after results arrive, so the shared cache never carries your preferences to anyone else."
      >
        <RuleList
          label="Always first"
          icon="pin-filled"
          domains={rules.pinned}
          onRemove={async (domain) => {
            await preferences.unpin(domain);
            setRules(preferences.snapshot());
          }}
        />
        <RuleList
          label="Never shown"
          icon="block"
          domains={rules.blocked}
          onRemove={async (domain) => {
            await preferences.unblock(domain);
            setRules(preferences.snapshot());
          }}
        />
      </Group>

      <Group
        icon="trash"
        title="Your data"
        note="Everything above lives in this browser and nowhere else."
      >
        <button
          type="button"
          className="settings__danger"
          onClick={() => {
            clearEverything();
            // A full reload is the honest confirmation: the app comes back with
            // no history, no rules, no keys and a fresh anonymous device token.
            window.location.reload();
          }}
        >
          <Icon name="trash" />
          <span>Erase history, favourites, rules and keys</span>
        </button>
      </Group>
    </section>
  );
}

/**
 * The licence key from checkout. Checked against the server as it is typed,
 * so a typo shows up here rather than as a mysteriously small quota later.
 */
function LicenseGroup() {
  const [key, setKey] = useState(() => readLicense());
  const [check, setCheck] = useState<LicenseCheck | undefined>();

  useEffect(() => {
    const trimmed = key.trim();
    if (!trimmed) {
      setCheck(undefined);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void checkLicense(serverUrl, trimmed).then((result) => {
        if (!cancelled) setCheck(result);
      });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [key]);

  return (
    <Group
      icon="key"
      title="Licence"
      note="Paste the key from checkout. It is sent with each search so the server can apply your plan, and it is the only thing that links searches to a purchase: there is no account behind it."
    >
      <Field
        label="Licence key"
        value={key}
        placeholder="jasb-xxxxx-xxxxx-xxxxx-xxxxx"
        secret={false}
        onChange={(value) => {
          setKey(value);
          writeLicense(value);
        }}
      />
      {check && <LicenseNotice check={check} />}
    </Group>
  );
}

function Group({
  icon,
  title,
  note,
  children,
}: {
  icon: Parameters<typeof Icon>[0]["name"];
  title: string;
  note: string;
  children: React.ReactNode;
}) {
  return (
    <section className="settings__group">
      <h3 className="settings__grouptitle">
        <Icon name={icon} />
        <span>{title}</span>
      </h3>
      <p className="settings__note">{note}</p>
      <div className="settings__fields">{children}</div>
    </section>
  );
}

function Field({
  label,
  hint,
  value,
  placeholder,
  onChange,
  secret = true,
}: {
  label: string;
  hint?: string;
  value: string;
  placeholder: string;
  onChange(value: string): void;
  secret?: boolean;
}) {
  return (
    <label className="field">
      <span className="field__label">
        {label}
        {hint && <span className="field__hint">{hint}</span>}
      </span>
      <input
        className="field__input"
        // `password` keeps a key out of shoulder-surfing range and out of the
        // browser's autofill heuristics for ordinary text fields.
        type={secret ? "password" : "text"}
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  options: { value: string; label: string }[];
}) {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      <select
        className="field__input"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function RuleList({
  label,
  icon,
  domains,
  onRemove,
}: {
  label: string;
  icon: Parameters<typeof Icon>[0]["name"];
  domains: string[];
  onRemove(domain: string): void;
}) {
  return (
    <div className="rules">
      <span className="label">
        <Icon name={icon} size={13} /> {label}
      </span>
      {domains.length === 0 ? (
        <p className="settings__note">None yet. Use Pin or Block on any result to build this list.</p>
      ) : (
        <ul className="rules__list">
          {domains.map((domain) => (
            <li key={domain} className="rules__item">
              <span className="mono">{domain}</span>
              <IconButton icon="close" label="Remove" onClick={() => onRemove(domain)} iconOnly />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
