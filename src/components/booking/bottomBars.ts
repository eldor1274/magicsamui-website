"use client";

// OWNER: foundation. Fixed bottom bars of the booking preview (the mobile
// cart bar and the "Having trouble paying?" strip) publish their heights as
// CSS variables on <html>, so the bars can stack instead of covering each
// other and the site's WhatsApp button can sit just above whatever is shown:
//   --bk-cart-bar-h  height of the mobile cart bar (0 when hidden, e.g. >= lg)
//   --bk-fab-lift    total height of all visible bottom bars

import { useEffect } from "react";
import type { RefObject } from "react";

export type BottomBarName = "cart" | "help";

const heights = new Map<BottomBarName, number>();

function publish(): void {
  const style = document.documentElement.style;
  const cart = heights.get("cart") ?? 0;
  let total = 0;
  for (const h of heights.values()) total += h;
  style.setProperty("--bk-cart-bar-h", `${cart}px`);
  style.setProperty("--bk-fab-lift", `${total}px`);
}

/** Tracks a fixed bottom bar's rendered height while `active` (0 when display:none). */
export function useBottomBar(name: BottomBarName, ref: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    const el = ref.current;
    if (!active || !el) return;
    const measure = () => {
      heights.set(name, el.offsetHeight);
      publish();
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      observer.disconnect();
      heights.delete(name);
      publish();
    };
  }, [name, ref, active]);
}

/** Inside a position: fixed box (a bottom bar, an open sheet): scrolling the page never moves it. */
function insideFixedBox(el: HTMLElement): boolean {
  for (let node: HTMLElement | null = el; node && node !== document.body; node = node.parentElement) {
    if (getComputedStyle(node).position === "fixed") return true;
  }
  return false;
}

/**
 * Programmatic focus() does not scroll a field that is "visible" but sits
 * under the fixed bottom bars or the sticky header (browsers ignore
 * scroll-padding for elements already in the viewport). Call after focusing
 * to scroll it clear of both. Never for the page itself (its bottom edge is
 * the footer) or a control in a fixed bar, and a block taller than the gap
 * keeps its top in view.
 */
export function revealAboveBars(el: HTMLElement | null, topClearance = 96): void {
  if (!el || el === document.body || el === document.documentElement || insideFixedBox(el)) return;
  const lift = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--bk-fab-lift")) || 0;
  const rect = el.getBoundingClientRect();
  const limit = window.innerHeight - lift - 16;
  if (rect.bottom > limit) {
    const by = Math.min(rect.bottom - limit, rect.top - topClearance);
    if (by > 0) window.scrollBy({ top: by, behavior: "auto" });
  } else if (rect.top < topClearance) window.scrollBy({ top: rect.top - topClearance, behavior: "auto" });
}
