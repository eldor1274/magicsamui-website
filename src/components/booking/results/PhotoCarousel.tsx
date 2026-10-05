"use client";

// OWNER: ui-search-results
// Room photo carousel: prev/next arrows (always on touch screens, on hover or
// focus with a mouse), swipe, and dots (a sliding window of 7 when a room has
// many photos). Fixed aspect ratio so the card never shifts while loading.
// Once the guest shows interest (hover, focus, touch) the previous and next
// photos are mounted invisibly too, so a slide is instant and cross-fades.

import { useRef, useState } from "react";
import type { ReactNode, TouchEvent } from "react";
import Image from "next/image";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { RoomPhoto } from "@/lib/booking/types";

export interface PhotoCarouselProps {
  photos: RoomPhoto[];
  /** Room name, used for the region label. */
  label: string;
  sizes: string;
  /** Overlay in the top-left corner (e.g. "Only 1 left"). */
  badge?: ReactNode;
  className?: string;
  /** Washed-out look for sold-out rooms. */
  muted?: boolean;
}

const MAX_DOTS = 7;
const SWIPE_PX = 40;

function dotWindow(count: number, active: number): number[] {
  if (count <= MAX_DOTS) return Array.from({ length: count }, (_, i) => i);
  const half = Math.floor(MAX_DOTS / 2);
  const start = Math.min(Math.max(0, active - half), count - MAX_DOTS);
  return Array.from({ length: MAX_DOTS }, (_, i) => start + i);
}

export default function PhotoCarousel({ photos, label, sizes, badge, className = "", muted = false }: PhotoCarouselProps) {
  const [index, setIndex] = useState(0);
  const [warm, setWarm] = useState(false);
  const touchX = useRef<number | null>(null);
  const count = photos.length;
  const active = Math.min(index, count - 1);
  const many = count > 1;
  const warmUp = many && !warm ? () => setWarm(true) : undefined;
  // The current photo plus, once warm, its neighbours (keyed by src: a neighbour that becomes current is already loaded).
  const mounted = [...new Set(warm ? [active, (active + 1) % count, (active - 1 + count) % count] : [active])];

  const go = (n: number) => setIndex(((n % count) + count) % count);

  const onTouchStart = (e: TouchEvent) => {
    touchX.current = e.touches[0]?.clientX ?? null;
    warmUp?.();
  };
  const onTouchEnd = (e: TouchEvent) => {
    const start = touchX.current;
    touchX.current = null;
    const end = e.changedTouches[0]?.clientX;
    if (start === null || end === undefined) return;
    const dx = end - start;
    if (Math.abs(dx) > SWIPE_PX) go(index + (dx < 0 ? 1 : -1));
  };

  // 44px on touch screens, 36px with a mouse.
  const arrow =
    "absolute top-1/2 z-10 inline-flex h-11 w-11 -translate-y-1/2 [@media(hover:hover)]:h-9 [@media(hover:hover)]:w-9 items-center justify-center rounded-full bg-(--bk-surface)/90 text-(--bk-text) shadow-(--bk-shadow-card) transition-opacity hover:bg-(--bk-surface) [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:focus-visible:opacity-100";

  return (
    <div
      role="region"
      aria-roledescription="carousel"
      aria-label={`${label} photos`}
      className={`group relative aspect-[4/3] overflow-hidden rounded-(--bk-radius-control) bg-(--bk-surface-sunken) ${className}`}
      onTouchStart={many ? onTouchStart : undefined}
      onTouchEnd={many ? onTouchEnd : undefined}
      onPointerEnter={warmUp}
      onFocus={warmUp}
    >
      {mounted.map((i) => {
        const photo = photos[i];
        if (!photo) return null;
        const shown = i === active;
        return (
          <Image
            key={photo.src}
            src={photo.src}
            alt={shown ? photo.alt : ""}
            aria-hidden={shown ? undefined : true}
            fill
            sizes={sizes}
            className={`object-cover transition-opacity duration-300 ${shown ? (muted ? "opacity-60 saturate-50" : "opacity-100") : "opacity-0"}`}
          />
        );
      })}

      {badge && <div className="absolute left-3 top-3 z-10">{badge}</div>}

      {many && (
        <>
          <button type="button" onClick={() => go(index - 1)} aria-label="Previous photo" className={`${arrow} left-2`}>
            <ChevronLeft size={18} aria-hidden="true" />
          </button>
          <button type="button" onClick={() => go(index + 1)} aria-label="Next photo" className={`${arrow} right-2`}>
            <ChevronRight size={18} aria-hidden="true" />
          </button>
          <div className="absolute inset-x-0 bottom-1.5 z-10 flex justify-center">
            <div className="flex items-center rounded-full bg-(--bk-overlay) px-1.5">
              {dotWindow(count, index).map((i) => (
                // Out of the tab order: Previous / Next already reach every photo (and "Photo N of M" is
                // announced), so a keyboard user doesn't tab through 7 dots per card. A 44px pointer hit area.
                <button
                  key={i}
                  type="button"
                  tabIndex={-1}
                  onClick={() => go(i)}
                  aria-label={`Go to image ${i + 1}`}
                  aria-current={i === index ? "true" : undefined}
                  className="group/dot relative inline-flex h-6 w-6 items-center justify-center before:absolute before:-inset-2.5"
                >
                  <span
                    className={`block h-1.5 rounded-full bg-(--bk-surface) transition-all ${
                      i === index ? "w-3 opacity-100" : "w-1.5 opacity-60 group-hover/dot:opacity-90"
                    }`}
                  />
                </button>
              ))}
            </div>
          </div>
          <p className="bk-sr-only" aria-live="polite">
            Photo {index + 1} of {count}
          </p>
        </>
      )}
    </div>
  );
}
