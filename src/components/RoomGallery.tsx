"use client";

import { useRef, useState } from "react";
import Image from "next/image";
import type { RoomImage } from "@/data/rooms";

// Clarity showed guests tapping/swiping the main photo expecting it to
// advance (10-35 dead taps per session on mobile) — so it does now: tap or
// swipe cycles the gallery, with a counter so the behavior is discoverable.
export default function RoomGallery({ images }: { images: RoomImage[] }) {
  const [active, setActive] = useState(0);
  const touchX = useRef<number | null>(null);
  const current = images[active] ?? images[0];
  const many = images.length > 1;

  const step = (dir: number) =>
    setActive((a) => (a + dir + images.length) % images.length);

  return (
    <div>
      <div
        className={`relative aspect-[16/10] w-full overflow-hidden rounded-2xl ${many ? "cursor-pointer" : ""}`}
        {...(many && {
          role: "button",
          tabIndex: 0,
          "aria-label": "Next photo",
          onClick: () => step(1),
          onKeyDown: (e: React.KeyboardEvent) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              step(1);
            }
          },
          onTouchStart: (e: React.TouchEvent) => {
            touchX.current = e.touches[0].clientX;
          },
          onTouchEnd: (e: React.TouchEvent) => {
            if (touchX.current === null) return;
            const dx = e.changedTouches[0].clientX - touchX.current;
            touchX.current = null;
            if (Math.abs(dx) > 40) step(dx < 0 ? 1 : -1);
          },
        })}
      >
        <Image
          key={current.src}
          src={current.src}
          alt={current.alt}
          fill
          priority
          sizes="(min-width: 1024px) 66vw, 100vw"
          className="object-cover"
        />
        {many && (
          <span className="absolute bottom-3 right-3 rounded-full bg-black/50 px-2.5 py-1 text-xs font-medium text-white">
            {active + 1} / {images.length}
          </span>
        )}
      </div>
      {many && (
        <div className="mt-3 grid grid-cols-4 gap-3 sm:grid-cols-6">
          {images.map((img, i) => (
            <button
              key={img.src}
              onClick={() => setActive(i)}
              className={`relative aspect-square overflow-hidden rounded-lg ring-2 transition-opacity ${
                i === active ? "ring-pool" : "ring-transparent opacity-80 hover:opacity-100"
              }`}
            >
              <Image
                src={img.src}
                alt={img.alt}
                fill
                sizes="120px"
                className="object-cover"
              />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
