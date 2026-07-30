import { useId, type InputHTMLAttributes, type ReactElement, type ReactNode } from "react";
import { fieldState } from "./variants.js";

/**
 * Field (handoff §3.1 / AC3) — the ONE text-input definition: label + control +
 * hint/error, covering default · focus · error · disabled. State comes from
 * props (`error`/`disabled`), never a hand-rolled border. Label↔input and
 * hint/error are wired with `htmlFor`/`aria-describedby`/`aria-invalid` so the
 * error is announced, not just coloured (AA).
 */
export interface FieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "prefix"> {
  label: string;
  hint?: string;
  /** Non-empty string puts the field in the error state and shows the message. */
  error?: string | null;
  /** Adornment shown inside the control (e.g. a "@" or URL scheme). */
  prefix?: ReactNode;
}

export function Field({
  label,
  hint,
  error,
  prefix,
  id,
  disabled,
  type = "text",
  ...rest
}: FieldProps): ReactElement {
  const autoId = useId();
  const inputId = id ?? autoId;
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;
  const state = fieldState({ error, disabled });
  const describedBy =
    [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(" ") ||
    undefined;

  return (
    <div className="ui-field" data-state={state}>
      <label className="ui-field__label" htmlFor={inputId}>
        {label}
      </label>
      <div className="ui-field__control" data-prefix={prefix ? "true" : undefined}>
        {prefix && (
          <span className="ui-field__prefix" aria-hidden="true">
            {prefix}
          </span>
        )}
        <input
          id={inputId}
          className="ui-field__input"
          type={type}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          {...rest}
        />
      </div>
      {error ? (
        <span id={errorId} className="ui-field__error" role="alert">
          {error}
        </span>
      ) : (
        hint && (
          <span id={hintId} className="ui-field__hint">
            {hint}
          </span>
        )
      )}
    </div>
  );
}
