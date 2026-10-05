"use client";

// OWNER: ui-search-results
// Room photo carousel: prev/next arrows (always on touch screens, on hover or
// focus with a mouse), swipe, and dots (a sliding window of 7 when a room has
// many photos). Fixed aspect ratio so the card never shifts while loading.

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
  const touchX = useRef<number | null>(null);
  const count = photos.length;
  const current = photos[Math.min(index, count - 1)];
  const many = count > 1;

  const go = (n: number) => setIndex(((n % count) + count) % count);

  const onTouchStart = (e: TouchEvent) => {
    touchX.current = e.touches[0]?.clientX ?? null;
  };
  const onTouchEnd = (e: TouchEvent) => {
    const start = touchX.current;
    touchX.current = null;
    const end = e.changedTouches[0]?.clientX;
    if (start === null || end === undefined) return;
    const dx = end - start;
    if (Math.abs(dx) > SWIPE_PX) go(index + (dx < 0 ? 1 : -1));
  };

  const arrow =
    "absolute top-1/2 z-10 inline-flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-(--bk-surface)/90 text-(--bk-text) shadow-(--bk-shadow-card) transition-opacity hover:bg-(--bk-surface) [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:focus-visible:opacity-100";

  return (
    <div
      role="region"
      aria-roledescription="carousel"
      aria-label={`${label} photos`}
      className={`group relative aspect-[4/3] overflow-hidden rounded-(--bk-radius-control) bg-(--bk-surface-sunken) ${className}`}
      onTouchStart={many ? onTouchStart : undefined}
      onTouchEnd={many ? onTouchEnd : undefined}
    >
      {current && (
        <Image
          key={current.src}
          src={current.src}
          alt={current.alt}
          fill
          sizes={sizes}
          className={`object-cover ${muted ? "opacity-60 saturate-50" : ""}`}
        />
      )}

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
                <button
                  key={i}
                  type="button"
                  onClick={() => go(i)}
                  aria-label={`Go to image ${i + 1}`}
                  aria-current={i === index ? "true" : undefined}
                  className="group/dot inline-flex h-6 w-4 items-center justify-center"
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
