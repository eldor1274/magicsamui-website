"use client";

// OWNER: ui-search-results
// Mobile sheet: "bottom" (dimmed backdrop, rounded top, drag the handle down
// to dismiss) or "fullscreen" (the mobile calendar). Same focus trap, Escape,
// return-focus and scroll lock as Modal. SheetProps is used by the mobile
// calendar, guests, promo, occupancy and summary sheets - keep it stable.

import { useId, useRef } from "react";
import type { ReactNode, RefObject, TouchEvent } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { BookingThemeScope } from "../BookingThemeRoot";
import { useOverlay } from "./overlay";
import { BTN_ICON } from "./styles";

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Optional second line under the title (e.g. "Oct 28, 2026 - Oct 31, 2026"). */
  subtitle?: string;
  /** "bottom" sheet with dimmed backdrop, or "fullscreen" (mobile calendar). */
  variant?: "bottom" | "fullscreen";
  children: ReactNode;
  footer?: ReactNode;
  initialFocusRef?: RefObject<HTMLElement | null>;
}

/** Drag distance (px) past which releasing the handle closes the sheet. */
const DISMISS_DRAG_PX = 90;

export default function Sheet({ open, onClose, title, subtitle, variant = "bottom", children, footer, initialFocusRef }: SheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const dragStartY = useRef<number | null>(null);
  const titleId = useId();
  const subtitleId = useId();
  const fullscreen = variant === "fullscreen";

  useOverlay({ open, containerRef: panelRef, onClose, initialFocusRef, lockScroll: true });

  if (!open || typeof document === "undefined") return null;

  const onDragStart = (e: TouchEvent) => {
    dragStartY.current = e.touches[0]?.clientY ?? null;
  };
  const onDragMove = (e: TouchEvent) => {
    const panel = panelRef.current;
    const start = dragStartY.current;
    const y = e.touches[0]?.clientY;
    if (!panel || start === null || y === undefined) return;
    const dy = Math.max(0, y - start);
    panel.style.transition = "none";
    panel.style.transform = `translateY(${dy}px)`;
  };
  const onDragEnd = (e: TouchEvent) => {
    const panel = panelRef.current;
    const start = dragStartY.current;
    dragStartY.current = null;
    if (!panel || start === null) return;
    const dy = (e.changedTouches[0]?.clientY ?? start) - start;
    panel.style.transition = "";
    panel.style.transform = "";
    if (dy > DISMISS_DRAG_PX) onClose();
  };

  return createPortal(
    <BookingThemeScope className="fixed inset-0 z-[60]">
      {!fullscreen && (
        <div
          className="absolute inset-0 bg-(--bk-overlay) transition-opacity duration-200 starting:opacity-0"
          onClick={onClose}
          aria-hidden="true"
        />
      )}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={subtitle ? subtitleId : undefined}
        tabIndex={-1}
        className={`absolute flex flex-col bg-(--bk-surface) text-(--bk-text) outline-none transition duration-200 ease-out ${
          fullscreen
            ? "inset-0 h-dvh starting:opacity-0"
            : "inset-x-0 bottom-0 max-h-[88dvh] rounded-t-(--bk-radius-card) shadow-(--bk-shadow-pop) starting:translate-y-full"
        }`}
      >
        {!fullscreen && (
          <div
            className="flex shrink-0 touch-none justify-center pb-1 pt-2.5"
            onTouchStart={onDragStart}
            onTouchMove={onDragMove}
            onTouchEnd={onDragEnd}
            aria-hidden="true"
          >
            <span className="h-1 w-10 rounded-full bg-(--bk-border-strong)" />
          </div>
        )}
        <div
          className={`flex shrink-0 items-start justify-between gap-4 px-5 ${
            fullscreen ? "border-b border-(--bk-border) pb-4 pt-[max(1rem,env(safe-area-inset-top))]" : "pb-2 pt-2"
          }`}
        >
          <div className="min-w-0">
            <h2 id={titleId} className="bk-heading text-lg leading-snug">
              {title}
            </h2>
            {subtitle && (
              <p id={subtitleId} className="mt-0.5 text-sm text-(--bk-text-subtle)">
                {subtitle}
              </p>
            )}
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className={`${BTN_ICON} -mr-2 h-10 w-10`}>
            <X size={20} aria-hidden="true" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-4 pt-2">{children}</div>
        {footer && (
          <div className="shrink-0 border-t border-(--bk-border) px-5 pb-[max(0.875rem,env(safe-area-inset-bottom))] pt-3.5">
            {footer}
          </div>
        )}
      </div>
    </BookingThemeScope>,
    document.body,
  );
}
