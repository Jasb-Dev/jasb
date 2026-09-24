import { useEffect, useRef, useState } from "react";
import { classify } from "@jasb/intent-engine";

import { Icon } from "./Icon.tsx";
import { Logo } from "./Logo.tsx";

/**
 * The intent bar.
 *
 * It replaces the address bar, so it has to be honest about which path the
 * input is taking *before* the user commits: a URL goes straight there, a bang
 * jumps, anything else becomes a search. The mode chip says which, live, as
 * they type — that is what stops the bar feeling like a black box.
 */
export interface IntentBarProps {
  value: string;
  onChange(value: string): void;
  onSubmit(value: string): void;
  busy?: boolean;
  /** Rendered on the right of the bar — theme toggle, settings, and so on. */
  actions?: React.ReactNode;
  placeholder?: string;
}

export function IntentBar({
  value,
  onChange,
  onSubmit,
  busy,
  actions,
  placeholder = "What are you looking for?",
}: IntentBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<"search" | "url" | "bang">("search");

  useEffect(() => {
    const trimmed = value.trim();
    setMode(trimmed ? classify(trimmed).kind : "search");
  }, [value]);

  // ⌘L / Ctrl-L focuses the bar, exactly as it does in every other browser.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const isFocusShortcut =
        ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "l") || event.key === "/";
      if (!isFocusShortcut) return;

      const target = event.target as HTMLElement | null;
      const typingElsewhere =
        target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable;
      // `/` is a legitimate character inside a field; only steal it otherwise.
      if (event.key === "/" && typingElsewhere) return;

      event.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <header className="bar">
      <div className="shell__inner bar__inner">
        <Logo size={26} className="bar__mark" />

        <form
          className="bar__field"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = value.trim();
            if (trimmed) onSubmit(trimmed);
          }}
        >
          <label className="visually-hidden" htmlFor="intent-input">
            What are you looking for?
          </label>
          <Icon name="search" className="bar__icon" />
          <input
            id="intent-input"
            ref={inputRef}
            className="bar__input"
            type="text"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder={placeholder}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="go"
            // eslint-disable-next-line jsx-a11y/no-autofocus -- this is the app's only entry point
            autoFocus
          />

          {value.trim() && (
            <span className="bar__mode">
              {mode === "url" ? "go" : mode === "bang" ? "bang" : "search"}
            </span>
          )}
          {!value.trim() && <span className="bar__hint">⌘L</span>}
        </form>

        <div className="bar__actions">
          {busy && (
            <span className="bar__hint" role="status">
              working…
            </span>
          )}
          {actions}
        </div>
      </div>
    </header>
  );
}
