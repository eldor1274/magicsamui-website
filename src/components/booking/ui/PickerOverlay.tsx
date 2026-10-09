"use client";

// OWNER: ui-search-results
// A small picker that is an anchored Popover on tablet/desktop and a bottom
// Sheet on phones (the Cloudbeds pattern for guests, promo code and the
// add-room occupancy picker). Mount it only while open.

import type { ReactNode, RefObject } from "react";
import { useIsMobile } from "../hooks";
import Popover from "./Popover";
import Sheet from "./Sheet";

export interface PickerOverlayProps {
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  /** Accessible name; also the sheet title on phones. */
  title: string;
  /** Second line in the phone sheet header. */
  subtitle?: string;
  align?: "start" | "center" | "end";
  /** Width classes for the desktop popover, e.g. "w-80". */
  popoverClassName?: string;
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Cancel / Apply row. */
  actions: ReactNode;
  children: ReactNode;
}

export default function PickerOverlay({
  onClose,
  anchorRef,
  title,
  subtitle,
  align = "start",
  popoverClassName = "w-80",
  initialFocusRef,
  actions,
  children,
}: PickerOverlayProps) {
  const isMobile = useIsMobile();

  if (isMobile) {
    return (
      <Sheet open onClose={onClose} title={title} subtitle={subtitle} footer={actions} initialFocusRef={initialFocusRef} returnFocusRef={anchorRef}>
        {children}
      </Sheet>
    );
  }

  return (
    <Popover
      open
      onClose={onClose}
      anchorRef={anchorRef}
      label={title}
      align={align}
      initialFocusRef={initialFocusRef}
      className={`max-w-[calc(100vw-1rem)] ${popoverClassName}`}
    >
      <div className="space-y-4">
        {children}
        {actions}
      </div>
    </Popover>
  );
}

/** Right-aligned Cancel / primary action row used inside pickers. */
export function PickerActions({ children, start }: { children: ReactNode; start?: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <div className="mr-auto">{start}</div>
      {children}
    </div>
  );
}
