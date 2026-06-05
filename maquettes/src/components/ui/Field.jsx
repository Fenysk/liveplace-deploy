// Field — text input with the full state matrix (default / focus / filled /
// error / disabled). One component, token-driven; "almost-the-same" inputs are
// forbidden (design-system discipline). Label + control are always linked, the
// error carries an icon + text (never colour-alone, §6), targets ≥44px (§5.4).
import { useId } from "react";

export default function Field({
  label, value = "", placeholder = "", hint, error,
  disabled = false, type = "text", prefix = null, state, id: idProp, ...rest
}) {
  const autoId = useId();
  const id = idProp || autoId;
  const hintId = `${id}-hint`;
  const invalid = !!error;

  // `state` lets the states board freeze a visual (focus) without real focus.
  const ring =
    state === "focus"
      ? "0 0 0 2px var(--ui-surface), 0 0 0 4px var(--accent-ring)"
      : invalid
      ? "0 0 0 1px var(--status-error-fg)"
      : "inset 0 0 0 1px var(--ui-border-strong)";

  return (
    <div className="w-full">
      {label && (
        <label htmlFor={id} className="mb-1.5 block text-[var(--text-sm)] font-semibold text-[var(--ui-text)]">
          {label}
        </label>
      )}
      <div
        className="flex min-h-[44px] items-center gap-2 rounded-[var(--da-radius-control)] bg-[var(--ui-surface-raised)] px-3 transition-shadow duration-[var(--dur-fast)]"
        style={{ boxShadow: ring, opacity: disabled ? 0.5 : 1 }}
      >
        {prefix && <span className="shrink-0 text-[var(--ui-text-tertiary)]">{prefix}</span>}
        <input
          id={id}
          type={type}
          defaultValue={value}
          placeholder={placeholder}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          aria-describedby={hint || error ? hintId : undefined}
          className="min-w-0 flex-1 bg-transparent py-2.5 text-[var(--text-base)] text-[var(--ui-text)] placeholder:text-[var(--ui-text-tertiary)] focus:outline-none"
          {...rest}
        />
      </div>
      {(error || hint) && (
        <p
          id={hintId}
          className="mt-1.5 flex items-center gap-1.5 text-[var(--text-xs)]"
          style={{ color: invalid ? "var(--status-error-fg)" : "var(--ui-text-secondary)" }}
        >
          {invalid && <span aria-hidden className="font-bold">!</span>}
          {error || hint}
        </p>
      )}
    </div>
  );
}
