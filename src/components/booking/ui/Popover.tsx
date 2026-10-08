"use client";

// OWNER: ui-search-results
// Anchored, non-modal dialog (desktop calendar, guests, promo, occupancy).
// Portals to <body> with position: fixed, placed under its anchor (flips
// above when there is no room below, clamped to the viewport, follows scroll
// and resize; a change of its own content never flips it). Focus moves in on
// open, Tab stays inside, Escape or a click outside closes it (a click that
// only closes it never follows a link underneath) and focus returns to the
// anchor. On phones the callers
// use a bottom Sheet instead. Keep PopoverProps stable (additions optional).

import { useLayoutEffect, useRef } from "react";
import type { ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";
import { BookingThemeScope } from "../BookingThemeRoot";
import { useOverlay } from "./overlay";

export interface PopoverProps {
  open: boolean;
  onClose: () => void;
  /** Element the popover is anchored to (and returns focus to). */
  anchorRef: RefObject<HTMLElement | null>;
  /** Accessible name of the dialog. */
  label: string;
  align?: "start" | "center" | "end";
  children: ReactNode;
  className?: string;
  /** Element to focus on open (default: the first focusable element). */
  initialFocusRef?: RefObject<HTMLElement | null>;
}

const GAP_PX = 8;
const VIEWPORT_MARGIN_PX = 8;
/** The site header is sticky (~77px on desktop). */
const HEADER_CLEARANCE_PX = 88;

export default function Popover({ open, onClose, anchorRef, label, align = "start", children, className = "", initialFocusRef }: PopoverProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useOverlay({
    open,
    containerRef: panelRef,
    onClose,
    initialFocusRef,
    returnFocusRef: anchorRef,
    closeOnOutsidePointer: true,
    ignoreRefs: [anchorRef],
  });

  // Positioning writes straight to the element's style (no React state), so
  // it is applied before the first paint and on every scroll/resize frame.
  useLayoutEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;
    let frame = 0;
    // The side (under or above the anchor) is chosen on open, scroll and resize only. A change of
    // the panel's own content (paging the calendar) keeps it: a flip would move the control the
    // guest is clicking, and the next click would land on the page underneath.
    let side: "bottom" | "top" | null = null;
    let reconsiderSide = true;

    const place = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const a = anchor.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      const vh = window.innerHeight;
      panel.style.maxHeight = "";
      const width = panel.offsetWidth;
      const height = panel.offsetHeight;

      let left = align === "start" ? a.left : align === "end" ? a.right - width : a.left + a.width / 2 - width / 2;
      left = Math.max(VIEWPORT_MARGIN_PX, Math.min(left, vw - width - VIEWPORT_MARGIN_PX));

      const spaceBelow = vh - a.bottom - GAP_PX - VIEWPORT_MARGIN_PX;
      const spaceAbove = a.top - GAP_PX - VIEWPORT_MARGIN_PX;
      const below = side !== null && !reconsiderSide ? side === "bottom" : height <= spaceBelow || spaceBelow >= spaceAbove;
      side = below ? "bottom" : "top";
      reconsiderSide = false;
      const available = Math.max(160, below ? spaceBelow : spaceAbove);
      const shown = Math.min(height, available);
      const top = below ? a.bottom + GAP_PX : a.top - GAP_PX - shown;

      panel.style.left = `${Math.round(left)}px`;
      panel.style.top = `${Math.round(top)}px`;
      if (height > available) panel.style.maxHeight = `${Math.floor(available)}px`;
      panel.dataset.side = below ? "bottom" : "top";
    };

    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(place);
    };
    const scheduleAndReconsider = () => {
      reconsiderSide = true;
      schedule();
    };

    // On open, scroll the page just enough for the whole panel to fit under
    // its anchor (never pushing the anchor under the sticky site header).
    const anchor = anchorRef.current;
    if (anchor) {
      const a = anchor.getBoundingClientRect();
      const spaceBelow = window.innerHeight - a.bottom - GAP_PX - VIEWPORT_MARGIN_PX;
      const need = panel.offsetHeight - spaceBelow;
      const room = a.top - HEADER_CLEARANCE_PX;
      if (need > 0 && room > 0) window.scrollBy({ top: Math.min(need, room), behavior: "instant" });
    }
    place();
    window.addEventListener("resize", scheduleAndReconsider);
    window.addEventListener("scroll", scheduleAndReconsider, true);
    const observer = new ResizeObserver(schedule);
    observer.observe(panel);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", scheduleAndReconsider);
      window.removeEventListener("scroll", scheduleAndReconsider, true);
      observer.disconnect();
    };
  }, [open, align, anchorRef]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <BookingThemeScope className="contents">
      <div
        ref={panelRef}
        role="dialog"
        aria-label={label}
        tabIndex={-1}
        className={`fixed left-0 top-0 z-[45] overflow-y-auto overscroll-contain rounded-(--bk-radius-card) border border-(--bk-border) bg-(--bk-surface) p-4 text-(--bk-text) shadow-(--bk-shadow-pop) outline-none transition-opacity duration-150 starting:opacity-0 ${className}`}
      >
        {children}
      </div>
    </BookingThemeScope>,
    document.body,
  );
}
