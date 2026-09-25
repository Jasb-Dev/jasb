import { useEffect, useState } from "react";
import { Icon, IconButton, LicenseNotice, checkLicense, type LicenseCheck } from "@jasb/ui";

import { serverEndpoint } from "../shared/client.ts";
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
      void serverEndpoint().then((server) => checkLicense(server, trimmed)).then((result) => {
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

          {check && <LicenseNotice check={check} />}
        </div>
      </section>
    </section>
  );
}
