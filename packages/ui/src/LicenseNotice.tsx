import { Icon } from "./Icon.tsx";
import { describeLicense, type LicenseCheck } from "./license.ts";

/** The one-line verdict under a licence field. */
export function LicenseNotice({ check }: { check: LicenseCheck }) {
  const { tone, text } = describeLicense(check);
  return (
    <p className={tone === "ok" ? "settings__ok" : "settings__warn"}>
      <Icon name={tone === "ok" ? "check" : "shield"} />
      <span>{text}</span>
    </p>
  );
}
