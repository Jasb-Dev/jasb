import { useEffect, useRef } from "react";
import { Icon } from "@jasb/ui";

import { companyList } from "./ShieldPanel.tsx";

export type TipId = "trackers" | "fire" | "done";

/**
 * A one-time tip in a strip between the toolbar and the page, which moves
 * down to make room, the way DuckDuckGo teaches its protections in context.
 * Three tips, each shown once, each at the moment it means something.
 */
export function TipBanner({
  tip,
  companies,
  onDismiss,
  onTryFire,
}: {
  tip: TipId;
  companies: string[];
  onDismiss(): void;
  onTryFire(): void;
}) {
  const ref = useRef<HTMLElement>(null);

  // Tell the main process how much room to leave above the page.
  useEffect(() => {
    const height = ref.current?.offsetHeight ?? 0;
    void window.jasb.setBannerHeight(height);
    return () => void window.jasb.setBannerHeight(0);
  }, [tip]);

  return (
    <aside ref={ref} className="tip" role="status">
      <div className="tip__bubble">
        {tip === "trackers" && (
          <>
            <p className="tip__text">
              <strong>{companyList(companies)}</strong> {companies.length === 1 ? "was" : "were"} trying to track
              you here. Jasb blocked {companies.length === 1 ? "it" : "them"}.
              <span className="tip__hint">
                <Icon name="shield" size={13} /> Click the shield for details.
              </span>
            </p>
            <button type="button" className="tip__primary" onClick={onDismiss}>
              Got it
            </button>
          </>
        )}
        {tip === "fire" && (
          <>
            <p className="tip__text">
              Clear your browsing activity instantly with the <strong>Fire button</strong>.
              <span className="tip__hint">
                <Icon name="flame" size={13} /> Tabs, cookies and history go; your keys and settings stay.
              </span>
            </p>
            <div className="tip__actions">
              <button type="button" className="tip__primary" onClick={onTryFire}>
                Try it
              </button>
              <button type="button" className="tip__secondary" onClick={onDismiss}>
                Skip
              </button>
            </div>
          </>
        )}
        {tip === "done" && (
          <>
            <p className="tip__text">
              <strong>You've got this.</strong> Every page you open here loads without its trackers,
              and every search ends on a real site, never on an answer written for you.
            </p>
            <button type="button" className="tip__primary" onClick={onDismiss}>
              High five
            </button>
          </>
        )}
        <button type="button" className="tip__close" aria-label="Dismiss tip" onClick={onDismiss}>
          <Icon name="close" size={12} />
        </button>
      </div>
    </aside>
  );
}
