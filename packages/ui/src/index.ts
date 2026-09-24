/**
 * @jasb/ui — the shared surface.
 *
 * Tokens plus a handful of components. Everything the user touches lives here,
 * so the web app, the Chrome new-tab page and the Electron shell cannot drift
 * apart visually.
 */

import "./tokens.css";
import "./base.css";
import "./components.css";

export { IntentBar, type IntentBarProps } from "./IntentBar.tsx";
export { ResultCard, QualityStrip, SkeletonCard, type ResultCardProps } from "./ResultCard.tsx";
export { EmptyState } from "./EmptyState.tsx";
export { StatusLine, Notice } from "./StatusLine.tsx";
export { useTheme, ThemeToggle, type Theme } from "./theme.tsx";
export { Icon, type IconName, type IconProps } from "./Icon.tsx";
export { Logo, LogoMark, type LogoProps } from "./Logo.tsx";
export { IconButton, type IconButtonProps } from "./IconButton.tsx";
