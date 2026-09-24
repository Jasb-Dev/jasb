import { useCallback, useEffect, useState } from "react";

import { IconButton } from "./IconButton.tsx";

export type Theme = "system" | "light" | "dark";

const STORAGE_KEY = "jasb.theme";

/**
 * Theme state.
 *
 * `system` is the default and stamps nothing, so the OS preference flows
 * through the media query. Choosing light or dark stamps `data-theme`, which
 * the token layer lets win in both directions — a user on a dark OS can still
 * force light here.
 */
export function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setThemeState] = useState<Theme>(() => read());

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") {
      root.removeAttribute("data-theme");
    } else {
      root.setAttribute("data-theme", theme);
    }

    try {
      if (theme === "system") localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Private mode or a storage-blocked context: the theme still applies for
      // this session, it just will not be remembered. Not worth surfacing.
    }
  }, [theme]);

  const setTheme = useCallback((next: Theme) => setThemeState(next), []);
  return [theme, setTheme];
}

function read(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

/**
 * Cycles system → light → dark.
 *
 * The glyph shows the mode currently in force, not the one the click would
 * select — a control that previews its own next state is a coin flip to read.
 */
export function ThemeToggle({
  theme,
  onChange,
}: {
  theme: Theme;
  onChange(theme: Theme): void;
}) {
  const next: Theme = theme === "system" ? "light" : theme === "light" ? "dark" : "system";
  const icon = theme === "system" ? "auto" : theme === "light" ? "sun" : "moon";

  return (
    <IconButton
      icon={icon}
      label={`Theme: ${theme}`}
      title={`Theme is ${theme}. Switch to ${next}.`}
      onClick={() => onChange(next)}
      iconOnly
    />
  );
}
