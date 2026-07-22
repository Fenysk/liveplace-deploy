import { cx } from "./variants.js";

export interface SwitchProps {
  /** Screen-reader label (visible labels should be placed by the caller). */
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  id?: string;
  disabled?: boolean;
}

export function Switch({
  label,
  checked,
  onChange,
  id,
  disabled,
}: SwitchProps): React.ReactElement {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={cx("lp-switch", checked ? "lp-switch--on" : "lp-switch--off")}
      onClick={() => onChange(!checked)}
    >
      <span className="lp-switch__track" aria-hidden="true">
        <span className="lp-switch__thumb" />
      </span>
    </button>
  );
}
