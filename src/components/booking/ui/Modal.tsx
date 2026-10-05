"use client";

// OWNER: ui-search-results
// Accessible dialog for the booking preview. Centered card on tablet/desktop,
// bottom sheet on phones. Focus is trapped while open and returns to the
// opener on close; Escape and the backdrop close it; the page behind does not
// scroll. Portals to <body> inside <BookingThemeScope> so theme tokens apply.
// ModalProps is shared with ui-checkout - keep it stable.

import { useId, useRef } from "react";
import type { ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { BookingThemeScope } from "../BookingThemeRoot";
import { useOverlay } from "./overlay";
import { BTN_ICON } from "./styles";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** Accessible name; shown as the heading unless hideTitle. */
  title: string;
  hideTitle?: boolean;
  /** sm 24rem, md 32rem, lg 48rem, xl 64rem max width. */
  size?: "sm" | "md" | "lg" | "xl";
  children: ReactNode;
  /** Sticky footer (actions). */
  footer?: ReactNode;
  /** Element to focus when opened (defaults to the close button). */
  initialFocusRef?: RefObject<HTMLElement | null>;
}

const WIDTH: Record<NonNullable<ModalProps["size"]>, string> = {
  sm: "sm:max-w-sm",
  md: "sm:max-w-lg",
  lg: "sm:max-w-3xl",
  xl: "sm:max-w-5xl",
};

export default function Modal({ open, onClose, title, hideTitle, size = "md", children, footer, initialFocusRef }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  useOverlay({ open, containerRef: panelRef, onClose, initialFocusRef: initialFocusRef ?? closeRef, lockScroll: true });

  if (!open || typeof document === "undefined") return null;

  const closeButton = (
    <button
      ref={closeRef}
      type="button"
      onClick={onClose}
      aria-label="Close"
      className={`${BTN_ICON} h-11 w-11 ${hideTitle ? "bg-(--bk-surface) shadow-(--bk-shadow-pop)" : "bg-(--bk-surface-sunken)"}`}
    >
      <X size={18} aria-hidden="true" />
    </button>
  );

  return createPortal(
    <BookingThemeScope className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center sm:p-6">
      <div
        className="absolute inset-0 bg-(--bk-overlay) transition-opacity duration-200 starting:opacity-0"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`relative flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-(--bk-radius-card) bg-(--bk-surface) text-(--bk-text) shadow-(--bk-shadow-pop) outline-none transition duration-200 ease-out starting:translate-y-6 starting:opacity-0 sm:max-h-[88dvh] sm:rounded-(--bk-radius-card) ${WIDTH[size]}`}
      >
        {hideTitle ? (
          <>
            <h2 id={titleId} className="bk-sr-only">
              {title}
            </h2>
            <div className="absolute right-3 top-3 z-10">{closeButton}</div>
          </>
        ) : (
          <div className="flex items-start justify-between gap-4 px-5 pb-2 pt-5 sm:px-6">
            <h2 id={titleId} className="bk-heading pt-1 text-lg leading-snug sm:text-xl">
              {title}
            </h2>
            {closeButton}
          </div>
        )}
        <div className={`min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-6 sm:px-6 ${hideTitle ? "pt-5" : "pt-2"}`}>
          {children}
        </div>
        {footer && (
          <div className="border-t border-(--bk-border) px-5 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 sm:px-6">{footer}</div>
        )}
      </div>
    </BookingThemeScope>,
    document.body,
  );
}
