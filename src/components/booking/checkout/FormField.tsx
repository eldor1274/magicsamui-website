"use client";

// OWNER: ui-checkout
// Cloudbeds-style outlined field: a small label inside the box above the
// value, a focus ring on the whole box, and an inline error underneath.
// The control itself is passed as children and should use FIELD_CONTROL_CLASS.

import type { ReactNode } from "react";

/** Classes for the input/select/textarea inside a FieldShell. 16px text avoids iOS zoom. */
export const FIELD_CONTROL_CLASS =
  "block w-full min-w-0 bg-transparent px-3 pb-2 pt-0.5 text-base text-(--bk-text) placeholder:text-(--bk-text-subtle) focus:outline-none focus-visible:outline-none!";

export function fieldErrorId(id: string): string {
  return `${id}-error`;
}

export function fieldHintId(id: string): string {
  return `${id}-hint`;
}

/** aria-describedby value for a field (error first so it is read first). */
export function describedBy(id: string, opts: { error?: boolean; hint?: boolean }): string | undefined {
  const ids = [opts.error ? fieldErrorId(id) : null, opts.hint ? fieldHintId(id) : null].filter(Boolean);
  return ids.length > 0 ? ids.join(" ") : undefined;
}

export interface FieldShellProps {
  /** id of the control the label points at. */
  id: string;
  label: string;
  required?: boolean;
  /** Shown under the box when set. */
  error?: string | null;
  hint?: ReactNode;
  /** Extra content on the right of the box (chevrons, counters). */
  trailing?: ReactNode;
  className?: string;
  children: ReactNode;
}

export default function FieldShell({ id, label, required, error, hint, trailing, className = "", children }: FieldShellProps) {
  const invalid = Boolean(error);
  return (
    <div className={className}>
      <div
        className={`relative flex items-stretch rounded-(--bk-radius-control) border bg-(--bk-surface) transition-[border-color,box-shadow] ${
          invalid
            ? "border-(--bk-danger) shadow-[0_0_0_1px_var(--bk-danger)] focus-within:shadow-[0_0_0_3px_var(--bk-danger-soft)]"
            : "border-(--bk-border-strong) focus-within:border-(--bk-focus) focus-within:shadow-[0_0_0_1px_var(--bk-focus)]"
        }`}
      >
        <div className="min-w-0 flex-1">
          <label htmlFor={id} className="block px-3 pt-2 text-xs font-medium text-(--bk-text-muted)">
            {label}
            {required && (
              <span aria-hidden="true" className="text-(--bk-danger)">
                {" "}
                *
              </span>
            )}
          </label>
          {children}
        </div>
        {trailing}
      </div>
      {hint && !invalid && (
        <p id={fieldHintId(id)} className="mt-1 px-1 text-xs text-(--bk-text-subtle)">
          {hint}
        </p>
      )}
      {invalid && (
        <p id={fieldErrorId(id)} className="mt-1 px-1 text-sm text-(--bk-danger)">
          {error}
        </p>
      )}
    </div>
  );
}
