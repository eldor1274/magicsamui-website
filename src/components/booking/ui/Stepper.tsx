"use client";

// OWNER: ui-search-results
// "[-] N [+]" counter row used by the guests and occupancy pickers. The
// buttons use aria-disabled (not disabled) at the limits so keyboard focus is
// never lost inside a focus-trapped popover; the value is announced politely.

import { useId } from "react";
import { Minus, Plus } from "lucide-react";

export interface StepperProps {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  /** Accessible name of + at the maximum, e.g. "Add guest, maximum occupancy reached". */
  maxReachedLabel?: string;
  /** Small note under the row, e.g. "Max: 2 per room". */
  note?: string;
}

export default function Stepper({ label, value, min, max, onChange, maxReachedLabel, note }: StepperProps) {
  const labelId = useId();
  const atMin = value <= min;
  const atMax = value >= max;
  const button =
    "inline-flex h-9 w-9 items-center justify-center rounded-full text-(--bk-text) transition-colors hover:bg-(--bk-surface-sunken) aria-disabled:cursor-not-allowed aria-disabled:opacity-35 aria-disabled:hover:bg-transparent";

  return (
    <div className="rounded-(--bk-radius-control) bg-(--bk-surface-sunken) px-4 py-3">
      <div className="flex items-center justify-between gap-4">
        <span id={labelId} className="text-sm font-medium">
          {label}
        </span>
        <div role="group" aria-labelledby={labelId} className="inline-flex items-center rounded-(--bk-radius-pill) border border-(--bk-border-strong) bg-(--bk-surface) p-0.5">
          <button
            type="button"
            aria-label={`Decrease ${label}`}
            aria-disabled={atMin}
            onClick={() => {
              if (!atMin) onChange(value - 1);
            }}
            className={button}
          >
            <Minus size={16} aria-hidden="true" />
          </button>
          <output aria-live="polite" aria-atomic="true" className="min-w-8 text-center font-medium tabular-nums">
            <span aria-hidden="true">{value}</span>
            <span className="bk-sr-only">
              {label}: {value}
            </span>
          </output>
          <button
            type="button"
            aria-label={atMax && maxReachedLabel ? maxReachedLabel : `Increase ${label}`}
            aria-disabled={atMax}
            onClick={() => {
              if (!atMax) onChange(value + 1);
            }}
            className={button}
          >
            <Plus size={16} aria-hidden="true" />
          </button>
        </div>
      </div>
      {note && <p className="mt-2 text-right text-xs text-(--bk-text-subtle)">{note}</p>}
    </div>
  );
}
