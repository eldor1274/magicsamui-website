"use client";

// OWNER: ui-search-results
// "View details": photo mosaic (1 large + 2x2, the last tile with "View All")
// that opens an in-modal gallery of every photo, then the room name,
// "Accommodates N", key facts, the description and the amenities in two
// columns. No price or Add button here (Cloudbeds pattern).
// Keep RoomDetailsModalProps stable.

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { ArrowLeft, Bath, BedDouble, Check, Images, Ruler, Users, Waves } from "lucide-react";
import { HOUSE_POLICIES } from "@/lib/booking/catalogue";
import type { CatalogueRoom } from "@/lib/booking/types";
import Modal from "../ui/Modal";
import { BTN_LINK, CHIP } from "../ui/styles";

export interface RoomDetailsModalProps {
  room: CatalogueRoom;
  open: boolean;
  onClose: () => void;
}

export default function RoomDetailsModal({ room, open, onClose }: RoomDetailsModalProps) {
  return (
    <Modal open={open} onClose={onClose} title={room.name} hideTitle size="lg">
      {open && <RoomDetailsBody room={room} />}
    </Modal>
  );
}

function RoomDetailsBody({ room }: { room: CatalogueRoom }) {
  const [galleryFrom, setGalleryFrom] = useState<number | null>(null);
  const [cameBack, setCameBack] = useState(false);

  if (galleryFrom !== null) {
    return (
      <RoomGalleryView
        room={room}
        startAt={galleryFrom}
        onBack={() => {
          setGalleryFrom(null);
          setCameBack(true);
        }}
      />
    );
  }
  return <RoomDetailsView room={room} onOpenGallery={setGalleryFrom} focusMosaic={cameBack} />;
}

function RoomDetailsView({
  room,
  onOpenGallery,
  focusMosaic,
}: {
  room: CatalogueRoom;
  onOpenGallery: (index: number) => void;
  /** Returning from the gallery: put focus back on the photos. */
  focusMosaic: boolean;
}) {
  const mosaicRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (focusMosaic) mosaicRef.current?.focus({ preventScroll: true });
  }, [focusMosaic]);
  const photos = room.gallery;
  const tiles = photos.slice(1, 5);
  const viewAll = (
    <span className="pointer-events-none absolute bottom-3 right-3 inline-flex items-center gap-1.5 rounded-(--bk-radius-pill) bg-(--bk-surface) px-3 py-1.5 text-xs font-semibold text-(--bk-text) shadow-(--bk-shadow-card)">
      <Images size={14} aria-hidden="true" />
      View All ({photos.length})
    </span>
  );

  const facts = [
    { icon: Users, text: `Up to ${room.maxGuests} guests` },
    { icon: BedDouble, text: `${room.bedrooms} ${room.bedrooms === 1 ? "bedroom" : "bedrooms"}` },
    { icon: Bath, text: `${room.bathrooms} ${room.bathrooms === 1 ? "bathroom" : "bathrooms"}` },
    { icon: Ruler, text: `${room.areaSqm} m²` },
    ...(room.hasPool && room.poolType ? [{ icon: Waves, text: room.poolType }] : []),
  ];

  return (
    <div className="space-y-6">
      {/* Mosaic */}
      <div className={`grid h-60 gap-2 sm:h-80 ${tiles.length >= 4 ? "sm:grid-cols-4 sm:grid-rows-2" : ""}`}>
        <button
          ref={mosaicRef}
          type="button"
          onClick={() => onOpenGallery(0)}
          aria-label={`View all ${photos.length} photos`}
          className={`relative overflow-hidden rounded-(--bk-radius-control) bg-(--bk-surface-sunken) ${
            tiles.length >= 4 ? "sm:col-span-2 sm:row-span-2" : ""
          }`}
        >
          {photos[0] && (
            <Image src={photos[0].src} alt={photos[0].alt} fill sizes="(min-width: 640px) 380px, 100vw" className="object-cover" />
          )}
          <span className={tiles.length >= 4 ? "sm:hidden" : ""}>{viewAll}</span>
        </button>
        {tiles.length >= 4 &&
          tiles.map((photo, i) => (
            <button
              key={photo.src}
              type="button"
              onClick={() => onOpenGallery(i + 1)}
              aria-label={i === tiles.length - 1 ? `View all ${photos.length} photos` : `Open photo ${i + 2}: ${photo.alt}`}
              className="relative hidden overflow-hidden rounded-(--bk-radius-control) bg-(--bk-surface-sunken) sm:block"
            >
              <Image src={photo.src} alt={photo.alt} fill sizes="190px" className="object-cover transition-transform duration-300 hover:scale-[1.03]" />
              {i === tiles.length - 1 && viewAll}
            </button>
          ))}
      </div>

      <div>
        <h3 className="bk-heading pr-10 text-2xl leading-tight">{room.name}</h3>
        <div className="mt-2 flex items-center gap-2 text-sm text-(--bk-text-muted)">
          Accommodates
          <span className={CHIP} aria-label={`${room.maxGuests} guests`}>
            <Users size={14} aria-hidden="true" />
            {room.maxGuests}
          </span>
        </div>
        <ul className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-sm">
          {facts.map(({ icon: Icon, text }) => (
            <li key={text} className="flex items-center gap-1.5">
              <Icon size={16} className="text-(--bk-accent)" aria-hidden="true" />
              {text}
            </li>
          ))}
        </ul>
      </div>

      <div className="space-y-3 text-sm leading-relaxed text-(--bk-text-muted)">
        {room.description.map((p, i) => (
          <p key={i}>{p}</p>
        ))}
      </div>

      {room.amenities.length > 0 && (
        <section aria-labelledby="room-amenities-heading" className="border-t border-(--bk-border) pt-5">
          <h4 id="room-amenities-heading" className="bk-heading text-lg">
            Accommodation Amenities
          </h4>
          <ul className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            {room.amenities.map((a) => (
              <li key={a} className="flex items-start gap-2">
                <Check size={16} className="mt-0.5 shrink-0 text-(--bk-accent)" aria-hidden="true" />
                {a}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="room-know-heading" className="border-t border-(--bk-border) pt-5">
        <h4 id="room-know-heading" className="bk-heading text-lg">
          Good to know
        </h4>
        <ul className="mt-3 space-y-1.5 text-sm text-(--bk-text-muted)">
          <li>
            {HOUSE_POLICIES.checkIn} · {HOUSE_POLICIES.checkOut}
          </li>
          <li>{HOUSE_POLICIES.children}</li>
          <li>{HOUSE_POLICIES.transfer}</li>
          <li>{HOUSE_POLICIES.deposit}</li>
        </ul>
      </section>
    </div>
  );
}

function RoomGalleryView({ room, startAt, onBack }: { room: CatalogueRoom; startAt: number; onBack: () => void }) {
  const backRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    backRef.current?.focus({ preventScroll: true });
    const target = listRef.current?.children[startAt];
    if (target instanceof HTMLElement) target.scrollIntoView({ block: "start" });
  }, [startAt]);

  return (
    <div className="space-y-4">
      <div className="sticky -top-5 z-10 -mx-5 flex items-center justify-between gap-3 bg-(--bk-surface) px-5 py-2 pr-14 sm:-mx-6 sm:px-6 sm:pr-16">
        <button ref={backRef} type="button" onClick={onBack} className={`${BTN_LINK} inline-flex items-center gap-1.5 text-sm no-underline hover:underline`}>
          <ArrowLeft size={16} aria-hidden="true" />
          Back to details
        </button>
        <p className="text-sm text-(--bk-text-muted)">{room.gallery.length} photos</p>
      </div>
      <ul ref={listRef} className="grid scroll-mt-14 gap-2 sm:grid-cols-2" aria-label={`${room.name} photos`}>
        {room.gallery.map((photo, i) => (
          <li
            key={photo.src}
            className={`relative scroll-mt-14 overflow-hidden rounded-(--bk-radius-control) bg-(--bk-surface-sunken) ${
              i % 3 === 0 ? "aspect-[16/10] sm:col-span-2" : "aspect-[4/3]"
            }`}
          >
            <Image src={photo.src} alt={photo.alt} fill sizes={i % 3 === 0 ? "(min-width: 640px) 720px, 100vw" : "(min-width: 640px) 360px, 100vw"} className="object-cover" />
          </li>
        ))}
      </ul>
    </div>
  );
}
