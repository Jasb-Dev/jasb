/**
 * The icon set.
 *
 * Drawn inline rather than pulled from a library: an icon font or an SVG
 * sprite means a network request, and a browser that waits on a CDN to draw its
 * own toolbar is a contradiction. Twenty glyphs is not worth a dependency.
 *
 * All of them share one grid — 24×24, 1.6 stroke, round caps, `currentColor` —
 * so they sit on the same optical weight as the mono labels beside them.
 */

export type IconName =
  | "search"
  | "settings"
  | "refresh"
  | "pin"
  | "pin-filled"
  | "block"
  | "sun"
  | "moon"
  | "auto"
  | "back"
  | "forward"
  | "plus"
  | "close"
  | "external"
  | "shield"
  | "gauge"
  | "lock"
  | "check"
  | "chevron"
  | "grid"
  | "key"
  | "trash"
  | "flame"
  | "cookie"
  | "sparkle"
  | "download"
  | "power";

export interface IconProps {
  name: IconName;
  /** Pixel size. Defaults to 16, which is the size the toolbars use. */
  size?: number;
  className?: string;
  /** Set when the icon is the only content of a control. */
  title?: string;
}

export function Icon({ name, size = 16, className, title }: IconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      // Decorative unless the caller gives it a name, in which case it is the
      // control's only label and must reach the accessibility tree.
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      focusable="false"
    >
      {title && <title>{title}</title>}
      {PATHS[name]}
    </svg>
  );
}

const PATHS: Record<IconName, React.ReactNode> = {
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
    </>
  ),

  // Sliders rather than a cog: these settings are levels and toggles, not
  // machinery, and sliders read faster at 16px than a cog's teeth.
  settings: (
    <>
      <path d="M4 7h10M18 7h2M4 12h4M12 12h8M4 17h8M16 17h4" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="10" cy="12" r="2" />
      <circle cx="14" cy="17" r="2" />
    </>
  ),

  refresh: (
    <>
      <path d="M20 12a8 8 0 1 1-2.6-5.9" />
      <path d="M20 4v4.5h-4.5" />
    </>
  ),

  pin: <path d="M9.5 3.5h5l-.8 5.2 3.3 3.3h-5V19l-1 2-1-2v-7H5l3.3-3.3-.8-5.2z" />,

  "pin-filled": (
    <path
      d="M9.5 3.5h5l-.8 5.2 3.3 3.3h-5V19l-1 2-1-2v-7H5l3.3-3.3-.8-5.2z"
      fill="currentColor"
    />
  ),

  // A domain struck through — "never show this again", not "error".
  block: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M6 6l12 12" />
    </>
  ),

  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4" />
    </>
  ),

  moon: <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" />,

  // "Follow the system": a display, half light and half dark.
  auto: (
    <>
      <rect x="3" y="4.5" width="18" height="13" rx="2" />
      <path d="M12 4.5v13" />
      <path d="M12 4.5h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-7z" fill="currentColor" stroke="none" />
      <path d="M8 21h8" />
    </>
  ),

  back: (
    <>
      <path d="M19 12H5" />
      <path d="M11 6l-6 6 6 6" />
    </>
  ),

  forward: (
    <>
      <path d="M5 12h14" />
      <path d="M13 6l6 6-6 6" />
    </>
  ),

  plus: <path d="M12 5v14M5 12h14" />,

  close: <path d="M6 6l12 12M18 6L6 18" />,

  external: (
    <>
      <path d="M14 4h6v6" />
      <path d="M20 4l-8.5 8.5" />
      <path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />
    </>
  ),

  shield: <path d="M12 3l7 3v5.5c0 4.3-2.9 8.2-7 9.5-4.1-1.3-7-5.2-7-9.5V6l7-3z" />,

  // The tracker meter, echoing the card's quality strip.
  gauge: (
    <>
      <path d="M4 18a8 8 0 1 1 16 0" />
      <path d="M12 18l4.5-4.5" />
    </>
  ),

  lock: (
    <>
      <rect x="4.5" y="10.5" width="15" height="10" rx="2" />
      <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
    </>
  ),

  check: <path d="M5 12.5l4.5 4.5L19 7" />,

  chevron: <path d="M9 6l6 6-6 6" />,

  // Six cells: the card grid itself.
  grid: (
    <>
      <rect x="3" y="4.5" width="5.5" height="6" rx="1.2" />
      <rect x="9.25" y="4.5" width="5.5" height="6" rx="1.2" />
      <rect x="15.5" y="4.5" width="5.5" height="6" rx="1.2" />
      <rect x="3" y="13.5" width="5.5" height="6" rx="1.2" />
      <rect x="9.25" y="13.5" width="5.5" height="6" rx="1.2" />
      <rect x="15.5" y="13.5" width="5.5" height="6" rx="1.2" />
    </>
  ),

  key: (
    <>
      <circle cx="8" cy="12" r="4" />
      <path d="M12 12h9M18 12v3.5M15.5 12v2.5" />
    </>
  ),

  // The Fire button: burn this session's browsing data.
  flame: (
    <path d="M12 21c-3.9 0-7-2.8-7-6.6 0-2.9 1.9-4.7 3.4-6.4.3 1.6 1.2 2.7 2.2 3.1-.2-3.1 1.1-5.8 3.6-8.1.3 2.9 1.6 4.6 3 6.1 1.1 1.2 1.8 2.6 1.8 4.8 0 4-3 7.1-7 7.1z" />
  ),

  cookie: (
    <>
      <path d="M20.5 12.5A8.5 8.5 0 1 1 11.5 3.5a3 3 0 0 0 3.5 3.5 3 3 0 0 0 5.5 5.5z" />
      <circle cx="8.5" cy="10" r="1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="15.5" r="1" fill="currentColor" stroke="none" />
      <circle cx="15.5" cy="12.5" r="1" fill="currentColor" stroke="none" />
    </>
  ),

  // "Surprise me": a spark, not a magic wand.
  sparkle: (
    <>
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4" />
      <path d="M6.3 6.3l2.5 2.5M15.2 15.2l2.5 2.5M17.7 6.3l-2.5 2.5M8.8 15.2l-2.5 2.5" />
    </>
  ),

  download: (
    <>
      <path d="M12 4v11" />
      <path d="M7 10.5l5 5 5-5" />
      <path d="M5 20h14" />
    </>
  ),

  power: (
    <>
      <path d="M12 3.5v8" />
      <path d="M7.1 6.6a7.5 7.5 0 1 0 9.8 0" />
    </>
  ),

  trash: (
    <>
      <path d="M4.5 7h15" />
      <path d="M9.5 7V5.5a1.5 1.5 0 0 1 1.5-1.5h2a1.5 1.5 0 0 1 1.5 1.5V7" />
      <path d="M6.5 7l.9 11.6A1.5 1.5 0 0 0 8.9 20h6.2a1.5 1.5 0 0 0 1.5-1.4L17.5 7" />
    </>
  ),
};
