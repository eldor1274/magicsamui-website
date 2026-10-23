"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Image from "next/image";
import { ChevronLeft, ChevronRight, Maximize2, X } from "lucide-react";
import type { RoomImage } from "@/data/rooms";

// Clarity showed guests tapping the main photo (10-35 dead taps per session
// on mobile). A tap now opens the photo full screen; swiping the photo or its
// arrows moves between photos, and the counter makes that discoverable.
// Owner, 22 Oct: a tap used to skip to the next photo, so guests could not
// look at one closely.
const SWIPE_PX = 40;

export default function RoomGallery({ images }: { images: RoomImage[] }) {
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const touchX = useRef<number | null>(null);
  // A swipe on the main photo must not also open it (the browser may send a click after the touch).
  const swiped = useRef(false);
  const photoRef = useRef<HTMLButtonElement>(null);
  const current = images[active] ?? images[0];
  const many = images.length > 1;

  const step = useCallback((dir: number) => setActive((a) => (a + dir + images.length) % images.length), [images.length]);

  const close = useCallback(() => {
    setOpen(false);
    photoRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div>
      <div className="relative aspect-[16/10] w-full overflow-hidden rounded-2xl">
        <button
          ref={photoRef}
          type="button"
          aria-label={`Enlarge photo ${active + 1} of ${images.length}`}
          className="absolute inset-0 block h-full w-full cursor-zoom-in"
          onClick={() => {
            if (swiped.current) {
              swiped.current = false;
              return;
            }
            setOpen(true);
          }}
          onTouchStart={(e) => {
            touchX.current = e.touches.length === 1 ? e.touches[0].clientX : null;
          }}
          onTouchEnd={(e) => {
            if (touchX.current === null || !many) return;
            const dx = e.changedTouches[0].clientX - touchX.current;
            touchX.current = null;
            if (Math.abs(dx) > SWIPE_PX) {
              swiped.current = true;
              window.setTimeout(() => {
                swiped.current = false;
              }, 400);
              step(dx < 0 ? 1 : -1);
            }
          }}
        >
          <Image
            key={current.src}
            src={current.src}
            alt={current.alt}
            fill
            // The first photo is the page's LCP element. `priority` is deprecated in
            // Next 16 and no longer set fetchpriority; preload + fetchPriority do.
            // Only the initial photo gets it - the ones the guest cycles to don't.
            preload={active === 0}
            fetchPriority={active === 0 ? "high" : "auto"}
            sizes="(min-width: 1024px) 66vw, 100vw"
            className="object-cover"
          />
        </button>
        {many && (
          <>
            <ArrowButton side="left" onClick={() => step(-1)} />
            <ArrowButton side="right" onClick={() => step(1)} />
          </>
        )}
        <span className="pointer-events-none absolute bottom-3 left-3 flex items-center gap-1.5 rounded-full bg-black/50 px-2.5 py-1 text-xs font-medium text-white">
          <Maximize2 size={12} aria-hidden="true" />
          <span className="sm:hidden">Tap</span>
          <span className="hidden sm:inline">Click</span> to enlarge
        </span>
        {many && (
          <span className="pointer-events-none absolute bottom-3 right-3 rounded-full bg-black/50 px-2.5 py-1 text-xs font-medium text-white">
            {active + 1} / {images.length}
          </span>
        )}
      </div>
      {many && (
        <div className="mt-3 grid grid-cols-4 gap-3 sm:grid-cols-6">
          {images.map((img, i) => (
            <button
              key={img.src}
              type="button"
              onClick={() => setActive(i)}
              aria-label={`Show photo ${i + 1}`}
              aria-current={i === active ? "true" : undefined}
              className={`relative aspect-square overflow-hidden rounded-lg ring-2 transition-opacity ${
                i === active ? "ring-pool" : "ring-transparent opacity-80 hover:opacity-100"
              }`}
            >
              <Image src={img.src} alt={img.alt} fill sizes="120px" className="object-cover" />
            </button>
          ))}
        </div>
      )}
      {open && <Lightbox images={images} active={active} onStep={step} onClose={close} />}
    </div>
  );
}

function ArrowButton({ side, onClick }: { side: "left" | "right"; onClick: () => void }) {
  const Icon = side === "left" ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={side === "left" ? "Previous photo" : "Next photo"}
      className={`absolute top-1/2 ${side === "left" ? "left-3" : "right-3"} flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-white transition-colors hover:bg-black/65`}
    >
      <Icon size={22} aria-hidden="true" />
    </button>
  );
}

/**
 * Full-screen photo viewer: arrows, swipe, arrow keys, Escape or X to close.
 * Pinch-zoom is left to the browser (only one-finger swipes change photos).
 */
function Lightbox({
  images,
  active,
  onStep,
  onClose,
}: {
  images: RoomImage[];
  active: number;
  onStep: (dir: number) => void;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const touchX = useRef<number | null>(null);
  const current = images[active] ?? images[0];
  const many = images.length > 1;

  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
    const html = document.documentElement;
    const before = html.style.overflow;
    html.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowRight" && many) {
        onStep(1);
      } else if (e.key === "ArrowLeft" && many) {
        onStep(-1);
      } else if (e.key === "Tab" && dialogRef.current) {
        // Keep keyboard focus on the viewer's own buttons.
        const items = Array.from(dialogRef.current.querySelectorAll<HTMLElement>("button"));
        const i = items.indexOf(document.activeElement as HTMLElement);
        e.preventDefault();
        items[(i + (e.shiftKey ? -1 : 1) + items.length) % items.length]?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      html.style.overflow = before;
    };
  }, [many, onClose, onStep]);

  return createPortal(
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Photo ${active + 1} of ${images.length}`}
      className="fixed inset-0 z-[100] flex flex-col bg-black"
      onClick={(e) => {
        // A tap on the dark area around the photo closes the viewer.
        if (e.target === e.currentTarget) onClose();
      }}
      onTouchStart={(e) => {
        touchX.current = e.touches.length === 1 ? e.touches[0].clientX : null;
      }}
      onTouchEnd={(e) => {
        if (touchX.current === null || !many) return;
        const dx = e.changedTouches[0].clientX - touchX.current;
        touchX.current = null;
        // A pinch-zoomed page pans with one finger: don't change photo then.
        if ((window.visualViewport?.scale ?? 1) > 1.01) return;
        if (Math.abs(dx) > SWIPE_PX) onStep(dx < 0 ? 1 : -1);
      }}
    >
      <div className="flex items-center justify-between px-4 pb-2 pt-[max(0.75rem,env(safe-area-inset-top))] text-white">
        <span className="text-sm font-medium">{many ? `${active + 1} / ${images.length}` : ""}</span>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label="Close photo"
          className="flex h-11 w-11 items-center justify-center rounded-full bg-white/10 transition-colors hover:bg-white/20"
        >
          <X size={22} aria-hidden="true" />
        </button>
      </div>
      <div
        className="relative min-h-0 flex-1"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <Image key={current.src} src={current.src} alt={current.alt} fill sizes="100vw" className="object-contain" />
        {many && (
          <>
            <ArrowButton side="left" onClick={() => onStep(-1)} />
            <ArrowButton side="right" onClick={() => onStep(1)} />
          </>
        )}
      </div>
      <p className="px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 text-center text-sm text-white/80">{current.alt}</p>
    </div>,
    document.body,
  );
}
