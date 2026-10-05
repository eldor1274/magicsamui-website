"use client";

// OWNER: ui-search-results
// Guests picker: one "Guests" stepper (adults only - children are not
// accommodated) with Cancel / Apply. Popover on desktop, bottom sheet on
// phones. The draft resets every time it opens. Keep GuestsPopoverProps stable.

import { useState } from "react";
import type { RefObject } from "react";
import { HOUSE_POLICIES } from "@/lib/booking/catalogue";
import PickerOverlay, { PickerActions } from "../ui/PickerOverlay";
import Stepper from "../ui/Stepper";
import { BTN_OUTLINE, BTN_PRIMARY } from "../ui/styles";

export interface GuestsPopoverProps {
  open: boolean;
  onClose: () => void;
  value: number;
  min: number;
  max: number;
  onApply: (adults: number) => void;
  anchorRef: RefObject<HTMLElement | null>;
}

export default function GuestsPopover(props: GuestsPopoverProps) {
  if (!props.open) return null;
  return <GuestsPicker {...props} />;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function GuestsPicker({ onClose, value, min, max, onApply, anchorRef }: GuestsPopoverProps) {
  const [draft, setDraft] = useState(() => clamp(value, min, max));

  return (
    <PickerOverlay
      onClose={onClose}
      anchorRef={anchorRef}
      title="Guests"
      align="center"
      popoverClassName="w-80"
      actions={
        <PickerActions>
          <button type="button" onClick={onClose} className={`${BTN_OUTLINE} h-11 text-sm`}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              onApply(draft);
              onClose();
            }}
            className={`${BTN_PRIMARY} h-11 text-sm`}
          >
            Apply
          </button>
        </PickerActions>
      }
    >
      <Stepper
        label="Guests"
        value={draft}
        min={min}
        max={max}
        onChange={setDraft}
        maxReachedLabel={`Add guest, maximum of ${max} reached`}
      />
      <p className="text-xs leading-relaxed text-(--bk-text-subtle)">{HOUSE_POLICIES.children}</p>
    </PickerOverlay>
  );
}
