import { useEffect, useState } from "react";
import { Icon, IconButton } from "@jasb/ui";

import { checkLicense, type LicenseCheck } from "../shared/client.ts";
import { loadLicense, saveLicense } from "../shared/rules.ts";

/**
 * The extension's settings: just the licence for now.
 *
 * Block and pin rules are managed from the cards themselves, and bookmarks and
 * history never leave the browser, so there is nothing else to configure.
 */
export function Settings({ onClose }: { onClose(): void }) {
  const [key, setKey] = useState("");
  const [check, setCheck] = useState<LicenseCheck | undefined>();

  useEffect(() => {
    void loadLicense().then(setKey);
  }, []);

  useEffect(() => {
    const trimmed = key.trim();
    if (!trimmed) {
      setCheck(undefined);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void checkLicense(trimmed).then((result) => {
        if (!cancelled) setCheck(result);
      });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [key]);

  return (
    <section className="settings">
      <header className="settings__head">
        <h2 className="settings__title">Settings</h2>
        <IconButton icon="close" label="Close" onClick={onClose} iconOnly />
      </header>

      <section className="settings__group">
        <h3 className="settings__grouptitle">
          <Icon name="key" />
          <span>Licence</span>
        </h3>
        <p className="settings__note">
          Paste the key from checkout. It is sent with each search so the server can apply your
          plan. There is no account behind it.
        </p>
        <div className="settings__fields">
          <label className="field">
            <span className="field__label">Licence key</span>
            <input
              className="field__input"
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={key}
              placeholder="jasb-xxxxx-xxxxx-xxxxx-xxxxx"
              onChange={(event) => {
                setKey(event.target.value);
                void saveLicense(event.target.value);
              }}
            />
          </label>

          {check?.status === "valid" && (
            <p className={check.active ? "settings__ok" : "settings__warn"}>
              <Icon name={check.active ? "check" : "shield"} />
              <span>
                {check.plan === "pro"
                  ? check.active
                    ? "Pro is active in this browser."
                    : "This Pro subscription is no longer active."
                  : "Supporter key recognised. Thank you."}
              </span>
            </p>
          )}
          {check?.status === "unknown" && (
            <p className="settings__warn">
              <Icon name="shield" />
              <span>That key is not recognised. Check for a typo, or email contact@jasb.dev.</span>
            </p>
          )}
          {check?.status === "unreachable" && (
            <p className="settings__warn">
              <Icon name="shield" />
              <span>Could not reach the server to check the key. It is saved anyway.</span>
            </p>
          )}
        </div>
      </section>
    </section>
  );
}
