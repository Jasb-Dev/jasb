import { useEffect, useState } from "react";
import { Icon } from "@jasb/ui";

import type { CompanyGroup, SiteReport } from "../shared/ipc.ts";

/**
 * The shield panel: what happened on this page, and the one switch that
 * matters when a site breaks.
 *
 * Modelled on DuckDuckGo's privacy dashboard: protections are shown, not
 * described. Every name and number here comes from requests the page
 * actually made; nothing is estimated.
 */
export function ShieldPanel({ onClose }: { onClose(): void }) {
  const [report, setReport] = useState<SiteReport | null>();
  const [open, setOpen] = useState<"blocked" | "loaded" | null>(null);

  useEffect(() => {
    void window.jasb.getSiteReport().then((value) => setReport(value ?? null));
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (report === undefined) return null;

  return (
    <div className="panel-scrim" onMouseDown={onClose}>
      <section
        className="shield-panel"
        role="dialog"
        aria-label="Protections for this site"
        onMouseDown={(event) => event.stopPropagation()}
      >
        {report === null ? (
          <p className="shield-panel__empty">Open a page to see what Jasb blocked on it.</p>
        ) : (
          <>
            <header className="shield-panel__head">
              <label className="shield-panel__switch">
                <span>
                  Protections are <strong>{report.paused ? "OFF" : "ON"}</strong> for this site
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  checked={!report.paused}
                  onChange={async () => {
                    await window.jasb.toggleAdblockForActiveSite();
                    setReport((await window.jasb.getSiteReport()) ?? null);
                  }}
                />
              </label>
              <button
                type="button"
                className="link-button shield-panel__report"
                onClick={() =>
                  void window.jasb.openExternal(
                    `mailto:dev@jasb.dev?subject=${encodeURIComponent(`Site problem: ${report.domain}`)}`,
                  )
                }
              >
                Report a problem with this site
              </button>
            </header>

            <div className="shield-panel__hero">
              <CompanyMarks groups={report.blocked} />
              <span className="shield-panel__domain">{report.domain}</span>
              <p className="shield-panel__summary">{summary(report)}</p>
            </div>

            <ul className="shield-panel__rows">
              <li className="shield-panel__row">
                <span className={`shield-panel__state ${report.secure ? "is-ok" : "is-warn"}`}>
                  <Icon name={report.secure ? "check" : "shield"} size={13} />
                </span>
                <span>{report.secure ? "Connection is encrypted" : "Connection is not encrypted"}</span>
              </li>

              {report.cookiePopup && (
                <li className="shield-panel__row">
                  <span className="shield-panel__state is-ok">
                    <Icon name="check" size={13} />
                  </span>
                  <span>Cookie pop-up declined for you ({report.cookiePopup})</span>
                </li>
              )}

              <ExpandableRow
                ok={report.blockedCount > 0 || report.blocked.length === 0}
                label={
                  report.blocked.length === 0
                    ? "No tracking requests found"
                    : `${report.blockedCount} requests blocked from loading`
                }
                groups={report.blocked}
                open={open === "blocked"}
                onToggle={() => setOpen(open === "blocked" ? null : "blocked")}
              />
              <ExpandableRow
                info
                label={`${report.loaded.reduce((sum, group) => sum + group.hosts.length, 0)} third-party hosts loaded`}
                groups={report.loaded}
                open={open === "loaded"}
                onToggle={() => setOpen(open === "loaded" ? null : "loaded")}
              />
            </ul>
          </>
        )}
      </section>
    </div>
  );
}

function summary(report: SiteReport): string {
  if (report.paused) {
    return "Protections are paused here, so trackers on this page were allowed to load.";
  }
  const named = report.blocked.filter((group) => group.known).map((group) => group.name);
  if (report.blocked.length === 0) return "We found no trackers on this page.";
  if (named.length === 0) {
    return `We blocked ${report.blocked.length} tracking ${report.blocked.length === 1 ? "domain" : "domains"} from loading on this page.`;
  }
  return `We blocked ${companyList(named)} from loading tracking requests on this page.`;
}

/** "Google", "Google and comScore", "Google, comScore, Amazon and 2 more". */
export function companyList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
  return `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
}

/** Up to three overlapping initials marks, the way the dashboard shows logos. */
function CompanyMarks({ groups }: { groups: CompanyGroup[] }) {
  const shown = groups.filter((group) => group.known).slice(0, 3);
  if (shown.length === 0) {
    return (
      <span className="company-marks">
        <span className="company-mark company-mark--clean">
          <Icon name="shield" size={22} />
        </span>
      </span>
    );
  }
  return (
    <span className="company-marks">
      {shown.map((group) => (
        <span key={group.name} className="company-mark" title={group.name}>
          {group.name.slice(0, 1)}
          <span className="company-mark__blocked" aria-hidden="true">
            <Icon name="block" size={11} />
          </span>
        </span>
      ))}
    </span>
  );
}

function ExpandableRow({
  label,
  groups,
  open,
  onToggle,
  ok,
  info,
}: {
  label: string;
  groups: CompanyGroup[];
  open: boolean;
  onToggle(): void;
  ok?: boolean;
  info?: boolean;
}) {
  return (
    <li className="shield-panel__row shield-panel__row--stack">
      <button type="button" className="shield-panel__rowbutton" onClick={onToggle} disabled={groups.length === 0}>
        <span className={`shield-panel__state ${info ? "is-info" : ok ? "is-ok" : "is-warn"}`}>
          <Icon name={info ? "gauge" : "check"} size={13} />
        </span>
        <span>{label}</span>
        {groups.length > 0 && (
          <span className={`shield-panel__chevron${open ? " is-open" : ""}`}>
            <Icon name="chevron" size={14} />
          </span>
        )}
      </button>
      {open && (
        <ul className="shield-panel__list">
          {groups.map((group) => (
            <li key={group.name}>
              <strong>{group.name}</strong>
              {group.known && <span className="mono"> · {group.hosts.join(", ")}</span>}
              <span className="shield-panel__count">{group.count}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
