"use client";

// OWNER: ui-search-results
// Shared behaviour for every booking overlay (Modal, Sheet, Popover):
// - a stack so only the top-most overlay reacts to Escape / Tab / outside clicks
// - focus: moves into the overlay on open, is trapped while open (over real
//   tab stops only), and returns to the opener (or a given element) on close -
//   unless the overlay's own action already moved focus somewhere on purpose;
//   the returned-to control is then scrolled clear of the fixed bottom bars
// - ref-counted page scroll lock with scrollbar-width compensation
// Everything is DOM work inside effects - no React state is set here.

import { useEffect, useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";
import { revealAboveBars } from "../bottomBars";

const FOCUSABLE = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  'input:not([disabled]):not([type="hidden"])',
  "select:not([disabled])",
  "textarea:not([disabled])",
  "iframe",
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(",");

/** Visible, keyboard-focusable descendants in DOM order (includes tabindex="-1" controls, e.g. roving calendar days). */
export function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.getClientRects().length > 0 && !el.closest("[inert]") && el.getAttribute("aria-hidden") !== "true",
  );
}

/** The real Tab stops among them: what the browser's Tab key visits. */
export function tabbableWithin(root: HTMLElement): HTMLElement[] {
  return focusableWithin(root).filter((el) => el.tabIndex >= 0);
}

/* ------------------------------ overlay stack ------------------------------ */

const stack: symbol[] = [];

function isTop(id: symbol): boolean {
  return stack[stack.length - 1] === id;
}

/* ------------------------------- scroll lock ------------------------------- */

let lockCount = 0;
let savedStyles: { overflow: string; paddingRight: string } | null = null;

function lockPageScroll(): void {
  lockCount += 1;
  if (lockCount > 1) return;
  const html = document.documentElement;
  const scrollbar = window.innerWidth - html.clientWidth;
  savedStyles = { overflow: html.style.overflow, paddingRight: document.body.style.paddingRight };
  html.style.overflow = "hidden";
  if (scrollbar > 0) document.body.style.paddingRight = `${scrollbar}px`;
}

function unlockPageScroll(): void {
  lockCount = Math.max(0, lockCount - 1);
  if (lockCount > 0 || !savedStyles) return;
  document.documentElement.style.overflow = savedStyles.overflow;
  document.body.style.paddingRight = savedStyles.paddingRight;
  savedStyles = null;
}

/**
 * Where focus goes when an overlay closes: the opener if it sits inside the
 * requested return target (e.g. the check-out button inside the dates pill),
 * else the target itself, or its first focusable child when the target is a
 * plain wrapper element.
 */
function resolveReturnFocus(target: HTMLElement | null, previouslyFocused: HTMLElement | null): HTMLElement | null {
  if (!target) return previouslyFocused;
  if (previouslyFocused && target.contains(previouslyFocused)) return previouslyFocused;
  if (target.matches(FOCUSABLE)) return target;
  return focusableWithin(target)[0] ?? previouslyFocused;
}

/**
 * A press outside a popover only closes it. When it lands on a link (the
 * homepage hero photo is one big link to /rooms), the click that follows must
 * not open that page as well. Capture phase on document: it runs before the
 * browser follows the link and before React (next/link) sees the click.
 */
function swallowNextClickOn(link: Element): void {
  const done = () => {
    document.removeEventListener("click", onClick, true);
    window.clearTimeout(timer);
  };
  const onClick = (e: MouseEvent) => {
    if (e.target instanceof Node && link.contains(e.target)) {
      e.preventDefault();
      e.stopPropagation();
    }
    done();
  };
  const timer = window.setTimeout(done, 3000);
  document.addEventListener("click", onClick, true);
}

/* --------------------------------- the hook -------------------------------- */

export interface OverlayOptions {
  open: boolean;
  /** The dialog element (focus is trapped inside it). */
  containerRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  /** Focused on open. Default: keep focus if a child already took it, else the first focusable element. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Focused on close. Default: whatever had focus before opening. */
  returnFocusRef?: RefObject<HTMLElement | null>;
  /** Lock page scrolling while open (modals and sheets). */
  lockScroll?: boolean;
  /** Close on a pointer press outside the container (popovers); a press on a link then doesn't follow it. */
  closeOnOutsidePointer?: boolean;
  /** Presses inside these elements never count as "outside" (e.g. the anchor that toggles a popover). */
  ignoreRefs?: RefObject<HTMLElement | null>[];
}

export function useOverlay(options: OverlayOptions): void {
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });

  const { open } = options;

  // Layout effect: runs before children's passive effects, so the element that
  // had focus before opening is captured correctly and a child (the calendar's
  // active day) can still take focus afterwards.
  useLayoutEffect(() => {
    if (!open) return;
    const id = Symbol("booking-overlay");
    stack.push(id);
    const opts = latest.current;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const locks = opts.lockScroll === true;
    if (locks) lockPageScroll();

    const container = opts.containerRef.current;
    if (container && !container.contains(document.activeElement)) {
      const target = opts.initialFocusRef?.current ?? focusableWithin(container)[0] ?? container;
      target.focus({ preventScroll: true });
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (!isTop(id)) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        latest.current.onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const root = latest.current.containerRef.current;
      if (!root) return;
      // Only real tab stops: a disabled Apply, or off-days with tabindex="-1",
      // must not count as the last stop, or Tab would slip out of the dialog.
      const items = tabbableWithin(root);
      if (items.length === 0) {
        e.preventDefault();
        root.focus({ preventScroll: true });
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (!active || !root.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
        return;
      }
      // Focus may sit on a control that is not itself a tab stop (the roving
      // calendar day): wrap when no tab stop follows (or precedes) it.
      const following = items.some((el) => active.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
      const preceding = items.some((el) => active.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING);
      if (e.shiftKey && (active === first || !preceding)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !following)) {
        e.preventDefault();
        first.focus();
      }
    };

    const onPointerDown = (e: PointerEvent) => {
      const cur = latest.current;
      if (!cur.closeOnOutsidePointer || !isTop(id)) return;
      const target = e.target instanceof Node ? e.target : null;
      const root = cur.containerRef.current;
      if (!target || !root || root.contains(target)) return;
      if (cur.ignoreRefs?.some((r) => r.current?.contains(target))) return;
      cur.onClose();
      const link = (target instanceof Element ? target : target.parentElement)?.closest("a[href]");
      if (link) swallowNextClickOn(link);
    };

    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
      const i = stack.indexOf(id);
      if (i >= 0) stack.splice(i, 1);
      if (locks) unlockPageScroll();
      // Restore only when focus is still in the overlay (or fell to <body> as
      // it unmounted). If the overlay's own action already moved focus on
      // purpose (a step heading, an invalid field), leave it there.
      const active = document.activeElement;
      const lost = active === null || active === document.body || (container !== null && container.contains(active));
      if (!lost) return;
      const back = resolveReturnFocus(latest.current.returnFocusRef?.current ?? null, previouslyFocused);
      if (!back || !back.isConnected) return;
      back.focus({ preventScroll: true });
      // The action may have just mounted a fixed bar (adding a room shows the
      // cart bar) that now covers the control: once the bar has published its
      // height (a passive effect of the same update), scroll the control clear
      // (WCAG 2.4.11). A timer, not rAF: it must run even when no frame is drawn.
      window.setTimeout(() => {
        if (document.activeElement === back) revealAboveBars(back);
      }, 50);
    };
  }, [open]);
}
