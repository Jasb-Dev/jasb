import { Icon, type IconName } from "./Icon.tsx";

/**
 * A control that is a glyph plus a label.
 *
 * The label stays in the DOM at every width — it is the accessible name and the
 * tooltip — and is only visually hidden on narrow viewports. An icon-only
 * button with no name is the most common accessibility failure in a toolbar,
 * and the cheapest one to avoid.
 */
export interface IconButtonProps {
  icon: IconName;
  label: string;
  onClick(): void;
  pressed?: boolean;
  disabled?: boolean;
  /** Hides the label at every width. Use only where the glyph is unambiguous. */
  iconOnly?: boolean;
  title?: string;
  className?: string;
}

export function IconButton({
  icon,
  label,
  onClick,
  pressed,
  disabled,
  iconOnly,
  title,
  className,
}: IconButtonProps) {
  return (
    <button
      type="button"
      className={`iconbtn${className ? ` ${className}` : ""}`}
      onClick={onClick}
      {...(pressed === undefined ? {} : { "aria-pressed": pressed })}
      disabled={disabled ?? false}
      title={title ?? label}
      aria-label={iconOnly ? label : undefined}
    >
      <Icon name={icon} />
      {!iconOnly && <span className="iconbtn__label">{label}</span>}
    </button>
  );
}
