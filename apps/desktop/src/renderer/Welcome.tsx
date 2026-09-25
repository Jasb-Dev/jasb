import { useEffect, useState } from "react";
import { Icon, LogoMark, randomSurprise, type IconName } from "@jasb/ui";

import type { WelcomeState } from "../shared/ipc.ts";

/**
 * First run, in four short steps.
 *
 * Borrowed from DuckDuckGo's onboarding, which gets one thing exactly right:
 * it shows what you gained instead of describing it. Step one is the same
 * side-by-side table; the rest is our own: how searches should run (our keys
 * or yours), the switching chores (bookmarks, start at login, the Chrome
 * extension), and a first search so the grid is never met empty.
 *
 * Every step can be skipped, and nothing here happens without a click.
 */

const STEPS = 4;

const PROTECTIONS: { icon: IconName; label: string; note?: string }[] = [
  { icon: "search", label: "Sites, not AI-written answers", note: "Chrome's address bar now answers for you" },
  { icon: "shield", label: "Block third-party trackers" },
  { icon: "cookie", label: "Decline cookie pop-ups for you" },
  { icon: "block", label: "Block ads" },
  { icon: "gauge", label: "See a page's trackers before you click" },
  { icon: "flame", label: "Clear browsing data with one button" },
  { icon: "lock", label: "No account, no search logs" },
];

const EXAMPLES = [
  "how do noise cancelling headphones work",
  "rust borrow checker cannot borrow as mutable",
  "no knead sourdough bread",
];


export function Welcome({ onFinish }: { onFinish(options: { search?: string; openSettings?: boolean }): void }) {
  const [step, setStep] = useState(1);
  const [state, setState] = useState<WelcomeState>();
  const [ownKeys, setOwnKeys] = useState(false);
  const [imported, setImported] = useState<string>();

  useEffect(() => {
    void window.jasb.getWelcome().then(setState);
  }, []);

  if (!state) return null;

  const finish = async (search?: string) => {
    await window.jasb.finishWelcome();
    onFinish({ ...(search ? { search } : {}), openSettings: ownKeys && !search });
  };

  return (
    <div className="welcome">
      <section className="welcome__card" aria-live="polite">
        <span className="welcome__progress" aria-label={`Step ${step} of ${STEPS}`}>
          <span className="welcome__dots" aria-hidden="true">
            {Array.from({ length: STEPS }, (_, i) => (
              <span key={i} className={`welcome__dot${i + 1 === step ? " is-current" : i + 1 < step ? " is-done" : ""}`} />
            ))}
          </span>
          {step} of {STEPS}
        </span>

        {step === 1 && (
          <>
            <h1 className="welcome__title">Protections activated.</h1>
            <p className="welcome__sub">Here is what changed the moment you opened Jasb.</p>
            <div className="compare" role="table" aria-label="Chrome compared with Jasb">
              <div className="compare__head" role="row">
                <span role="columnheader" />
                <span role="columnheader" className="compare__brand">Chrome</span>
                <span role="columnheader" className="compare__brand compare__brand--us">
                  <LogoMark size={22} compact />
                  Jasb
                </span>
              </div>
              {PROTECTIONS.map((row) => (
                <div key={row.label} className="compare__row" role="row">
                  <span role="cell" className="compare__label">
                    <span className="compare__icon">
                      <Icon name={row.icon} size={16} />
                    </span>
                    <span>
                      {row.label}
                      {row.note && <span className="compare__note">{row.note}</span>}
                    </span>
                  </span>
                  <span role="cell" className="compare__mark compare__mark--no" aria-label="No">
                    <Icon name="close" size={12} />
                  </span>
                  <span role="cell" className="compare__mark compare__mark--yes" aria-label="Yes">
                    <Icon name="check" size={13} />
                  </span>
                </div>
              ))}
            </div>
            <div className="welcome__actions">
              {state.canMakeDefault && !state.isDefault ? (
                <button
                  type="button"
                  className="welcome__primary"
                  onClick={async () => {
                    setState(await window.jasb.makeDefaultBrowser());
                    setStep(2);
                  }}
                >
                  Make Jasb your default browser
                </button>
              ) : (
                <button type="button" className="welcome__primary" onClick={() => setStep(2)}>
                  Next
                </button>
              )}
              <button type="button" className="welcome__secondary" onClick={() => setStep(2)}>
                Skip
              </button>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <h1 className="welcome__title">How should Jasb search?</h1>
            <p className="welcome__sub">You can change this any time in Settings.</p>
            <div className="choice">
              <button
                type="button"
                className={`choice__option${!ownKeys ? " is-selected" : ""}`}
                onClick={() => setOwnKeys(false)}
                aria-pressed={!ownKeys}
              >
                <span className="choice__title">Jasb Search</span>
                <span className="choice__price">50 free searches a month</span>
                <span className="choice__body">Nothing to set up. Runs on our keys, with no account and no search logs.</span>
              </button>
              <button
                type="button"
                className={`choice__option${ownKeys ? " is-selected" : ""}`}
                onClick={() => setOwnKeys(true)}
                aria-pressed={ownKeys}
              >
                <span className="choice__title">My own keys</span>
                <span className="choice__price">Free and unlimited</span>
                <span className="choice__body">Bring a search and a model key (or Ollama). Searches go straight from this Mac to your providers.</span>
              </button>
            </div>
            <div className="welcome__actions">
              <button type="button" className="welcome__primary" onClick={() => setStep(3)}>
                Next
              </button>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <h1 className="welcome__title">Let's get you set up.</h1>
            <p className="welcome__sub">The chores of switching, done in a click each.</p>
            <ul className="setup">
              <li className="setup__row">
                <span className="setup__icon">
                  <Icon name="download" size={18} />
                </span>
                <span className="setup__label">
                  {state.browsers.length > 0
                    ? `Import bookmarks from ${state.browsers[0]}`
                    : "Import bookmarks"}
                  {imported && <span className="setup__note">{imported}</span>}
                </span>
                <button
                  type="button"
                  className="setup__button"
                  disabled={state.browsers.length === 0 || Boolean(imported)}
                  onClick={async () => {
                    const { added, found } = await window.jasb.importBookmarks(state.browsers[0]);
                    setImported(
                      found === 0 ? "No bookmarks found." : `${added} added to your favourites${found > added ? ` (${found - added} were already here)` : ""}.`,
                    );
                  }}
                  title={state.browsers.length === 0 ? "No Chrome, Brave, Edge or Arc profile found" : undefined}
                >
                  {imported ? "Imported" : "Import"}
                </button>
              </li>
              <li className="setup__row">
                <span className="setup__icon">
                  <Icon name="power" size={18} />
                </span>
                <span className="setup__label">Open Jasb when your computer starts</span>
                <label className="setup__toggle">
                  <input
                    type="checkbox"
                    role="switch"
                    checked={state.openAtLogin}
                    onChange={async (event) => setState(await window.jasb.setOpenAtLogin(event.target.checked))}
                  />
                </label>
              </li>
              <li className="setup__row">
                <span className="setup__icon">
                  <Icon name="grid" size={18} />
                </span>
                <span className="setup__label">
                  Search the same way inside Chrome
                  <span className="setup__note">The extension puts Jasb on the new-tab page and behind "j" in the address bar.</span>
                </span>
                <button
                  type="button"
                  className="setup__button"
                  onClick={() => void window.jasb.openExternal("https://jasb.dev/#get")}
                >
                  Get extension
                </button>
              </li>
            </ul>
            <div className="welcome__actions">
              <button type="button" className="welcome__primary" onClick={() => setStep(4)}>
                Next
              </button>
            </div>
          </>
        )}

        {step === 4 && (
          <>
            <h1 className="welcome__title">Ready? Try a search.</h1>
            <p className="welcome__sub">
              Write it the way you would ask a person. You get a handful of sites, each labelled
              with what it is, and the answer stays where it was written.
            </p>
            <div className="chips">
              {EXAMPLES.map((example) => (
                <button key={example} type="button" className="chip" onClick={() => void finish(example)}>
                  <Icon name="search" size={14} />
                  {example}
                </button>
              ))}
              <button
                type="button"
                className="chip chip--surprise"
                onClick={() => void finish(randomSurprise())}
              >
                <Icon name="sparkle" size={14} />
                Surprise me
              </button>
            </div>
            <div className="welcome__actions">
              <button type="button" className="welcome__secondary" onClick={() => void finish()}>
                {ownKeys ? "Add my keys first" : "I'll search myself"}
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
