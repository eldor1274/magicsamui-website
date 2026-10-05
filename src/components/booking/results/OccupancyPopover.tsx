"use client";

// OWNER: ui-search-results
// "Add" picker on a rate row: Adults stepper capped at the room's maximum,
// "Max: N per room", Cancel / Confirm. Popover under the Add button on
// desktop, bottom sheet on phones. Quantity is always 1 (every room type is a
// single unit) and children are not offered (house rule).
// Keep OccupancyPopoverProps stable.

import { useState } from "react";
import type { RefObject } from "react";
import PickerOverlay, { PickerActions } from "../ui/PickerOverlay";
import Stepper from "../ui/Stepper";
import { BTN_OUTLINE, BTN_PRIMARY } from "../ui/styles";

export interface OccupancyPopoverProps {
  open: boolean;
  onClose: () => void;
  onConfirm: (adults: number) => void;
  roomName: string;
  ratePlanName: string;
  maxAdults: number;
  defaultAdults: number;
  anchorRef: RefObject<HTMLElement | null>;
}

export default function OccupancyPopover(props: OccupancyPopoverProps) {
  if (!props.open) return null;
  return <OccupancyPicker {...props} />;
}

function OccupancyPicker({ onClose, onConfirm, roomName, ratePlanName, maxAdults, defaultAdults, anchorRef }: OccupancyPopoverProps) {
  const max = Math.max(1, maxAdults);
  const [adults, setAdults] = useState(() => Math.min(max, Math.max(1, defaultAdults)));

  return (
    <PickerOverlay
      onClose={onClose}
      anchorRef={anchorRef}
      title={roomName}
      subtitle={ratePlanName}
      align="end"
      popoverClassName="w-80"
      actions={
        <PickerActions>
          <button type="button" onClick={onClose} className={`${BTN_OUTLINE} h-11 text-sm`}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              onConfirm(adults);
              onClose();
            }}
            className={`${BTN_PRIMARY} h-11 text-sm`}
          >
            Confirm
          </button>
        </PickerActions>
      }
    >
      <div className="hidden md:block">
        <p className="text-sm font-semibold leading-snug">{roomName}</p>
        <p className="text-xs text-(--bk-text-muted)">{ratePlanName} · 1 room</p>
      </div>
      <Stepper
        label="Adults"
        value={adults}
        min={1}
        max={max}
        onChange={setAdults}
        maxReachedLabel="Add guest, maximum occupancy reached"
        note={`Max: ${max} per room`}
      />
      <p className="text-xs leading-relaxed text-(--bk-text-subtle)">Children are not accommodated - all guests are counted as adults.</p>
    </PickerOverlay>
  );
}
