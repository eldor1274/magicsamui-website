"use client";

// OWNER: ui-checkout
// "Add-ons and Extras" step: one tab per room in the cart (add-ons are per
// room, like Cloudbeds), an add-on card per extra with its price, the
// weekdays it is served, the total for this stay and Add / Remove. Continue
// lives in the summary CTA / mobile bar. Keep AddonsStepProps stable.

import { useId, useState } from "react";
import type { KeyboardEvent } from "react";
import Image from "next/image";
import { Check, Coffee, Plane } from "lucide-react";
import { ADDONS, ADDON_IDS, FREE_PICKUP_MIN_NIGHTS, HOUSE_POLICIES, RATE_PLANS, getCatalogueRoom } from "@/lib/booking/catalogue";
import { WEEKDAYS_LONG, WEEKDAYS_MIN, WEEKDAYS_SHORT, formatDisplayDate, nightsBetween, weekday } from "@/lib/booking/dates";
import { formatThb } from "@/lib/booking/format";
import { addonEligibleNights, addonTotalSatang } from "@/lib/booking/quote";
import type { AddonId, AddonInfo, CartItem, IsoDate } from "@/lib/booking/types";

export interface AddonsStepProps {
  cart: CartItem[];
  checkIn: IsoDate;
  checkOut: IsoDate;
  onToggleAddon: (itemId: string, addonId: AddonId) => void;
}

/** "2026-11-18" -> "Wed Nov 18" */
function shortNight(date: IsoDate): string {
  return `${WEEKDAYS_SHORT[weekday(date)]} ${formatDisplayDate(date).replace(/,\s*\d{4}$/, "")}`;
}

function listJoin(words: string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

function WeekdayDots({ available }: { available: number[] }) {
  const names = available.map((d) => WEEKDAYS_LONG[d]);
  return (
    <div>
      <p className="text-xs text-(--bk-text-subtle)">Available on</p>
      <p className="bk-sr-only">{listJoin(names)} nights</p>
      <div aria-hidden="true" className="mt-1 flex gap-1">
        {WEEKDAYS_MIN.map((label, i) => {
          const on = available.includes(i);
          return (
            <span
              key={label}
              className={`inline-flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-semibold ${
                on ? "bg-(--bk-text) text-(--bk-surface)" : "border border-(--bk-border-strong) text-(--bk-text-subtle)"
              }`}
            >
              {label}
            </span>
          );
        })}
      </div>
    </div>
  );
}

interface AddonCardProps {
  addon: AddonInfo;
  item: CartItem;
  roomName: string;
  checkIn: IsoDate;
  checkOut: IsoDate;
  onToggle: () => void;
}

function AddonCard({ addon, item, roomName, checkIn, checkOut, onToggle }: AddonCardProps) {
  const added = item.addonIds.includes(addon.id);
  const planAllows = addon.ratePlans.includes(item.ratePlanId);
  const nights = addonEligibleNights(addon, checkIn, checkOut);
  const total = addonTotalSatang(addon, item.adults, checkIn, checkOut);
  const servedOn = listJoin(addon.availableWeekdays.map((d) => WEEKDAYS_LONG[d]));
  const canAdd = planAllows && nights.length > 0;

  return (
    <article
      className={`overflow-hidden rounded-(--bk-radius-card) border bg-(--bk-surface) transition-colors sm:grid sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] ${
        added ? "border-(--bk-accent) shadow-[0_0_0_1px_var(--bk-accent)]" : "border-(--bk-border)"
      }`}
    >
      <div className="relative aspect-[16/10] bg-(--bk-surface-sunken) sm:aspect-auto sm:min-h-56">
        {addon.image ? (
          <Image
            src={addon.image.src}
            alt={addon.image.alt}
            fill
            sizes="(min-width: 1024px) 280px, (min-width: 640px) 40vw, 100vw"
            className="object-cover"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-(--bk-text-subtle)">
            <Coffee size={36} aria-hidden="true" />
          </div>
        )}
        {added && (
          <span className="absolute left-3 top-3 inline-flex items-center gap-1 rounded-(--bk-radius-pill) bg-(--bk-accent) px-2.5 py-1 text-xs font-semibold text-(--bk-accent-contrast)">
            <Check size={12} aria-hidden="true" /> Added
          </span>
        )}
      </div>

      <div className="flex flex-col gap-3 p-4 sm:p-5">
        <div>
          <h3 className="bk-heading text-lg text-(--bk-text)">{addon.name}</h3>
          <p className="mt-0.5">
            <span className="bk-price font-semibold text-(--bk-text)">{formatThb(addon.priceSatangPerGuestPerNight)}</span>{" "}
            <span className="text-xs text-(--bk-text-muted)">Per Guest Per Night</span>
          </p>
          <p className="mt-2 text-sm leading-relaxed text-(--bk-text-muted)">{addon.description}</p>
        </div>

        <WeekdayDots available={addon.availableWeekdays} />

        {!planAllows ? (
          <p className="inline-flex items-center gap-2 self-start rounded-(--bk-radius-pill) bg-(--bk-accent-soft) px-3 py-1.5 text-sm font-medium text-(--bk-accent-soft-text)">
            <Check size={14} aria-hidden="true" />
            Included in your {RATE_PLANS[item.ratePlanId].name} rate
          </p>
        ) : nights.length === 0 ? (
          <p className="text-sm text-(--bk-text-muted)">Not available for your dates - it is served on {servedOn} nights only.</p>
        ) : (
          <p className="text-xs text-(--bk-text-muted)">
            For your stay: {nights.length} {nights.length === 1 ? "night" : "nights"} ({nights.map(shortNight).join(", ")}) × {item.adults}{" "}
            {item.adults === 1 ? "guest" : "guests"}
          </p>
        )}

        {planAllows && (
          <div className="mt-auto flex items-center justify-between gap-3 border-t border-(--bk-border) pt-3">
            <p>
              {canAdd || added ? (
                <>
                  <span className="bk-price text-lg font-semibold text-(--bk-text)">{formatThb(total)}</span>{" "}
                  <span className="text-sm text-(--bk-text-muted)">Total</span>
                </>
              ) : (
                <span className="text-sm text-(--bk-text-subtle)">Not available</span>
              )}
            </p>
            {(canAdd || added) && (
              <button
                type="button"
                onClick={onToggle}
                aria-pressed={added}
                aria-label={`${added ? "Remove" : "Add"} ${addon.name} for ${roomName}`}
                className={`inline-flex min-h-10 items-center gap-1.5 rounded-(--bk-radius-pill) border px-5 text-sm font-medium transition-colors ${
                  added
                    ? "border-(--bk-border-strong) bg-(--bk-surface) text-(--bk-text) hover:border-(--bk-danger) hover:text-(--bk-danger)"
                    : "border-(--bk-accent) bg-(--bk-surface) text-(--bk-text) hover:bg-(--bk-accent) hover:text-(--bk-accent-contrast)"
                }`}
              >
                {added ? "Remove" : "Add"}
              </button>
            )}
          </div>
        )}
      </div>
    </article>
  );
}

export default function AddonsStep({ cart, checkIn, checkOut, onToggleAddon }: AddonsStepProps) {
  const baseId = useId();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const activeItem = cart.find((c) => c.id === selectedId) ?? cart[0];
  const nights = nightsBetween(checkIn, checkOut);
  const pickupIncluded = nights >= FREE_PICKUP_MIN_NIGHTS;

  const tabId = (id: string) => `${baseId}-tab-${id}`;
  const panelId = `${baseId}-panel`;

  function onTabKey(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next = -1;
    if (e.key === "ArrowRight") next = (index + 1) % cart.length;
    else if (e.key === "ArrowLeft") next = (index - 1 + cart.length) % cart.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = cart.length - 1;
    if (next < 0) return;
    e.preventDefault();
    setSelectedId(cart[next].id);
    document.getElementById(tabId(cart[next].id))?.focus();
  }

  if (!activeItem) return null;
  const activeRoom = getCatalogueRoom(activeItem.slug);
  const activeRoomName = activeRoom?.name ?? activeItem.slug;

  return (
    <div className="space-y-4 rounded-(--bk-radius-card) bg-(--bk-surface) p-4 shadow-(--bk-shadow-card) sm:p-6">
      <div className="space-y-1 text-sm text-(--bk-text-muted)">
        <p>Enhance your stay with our special perks &amp; upgrades.</p>
        <p>Add-ons are on a per-room basis, please select the items individually for each accommodation below.</p>
      </div>

      <div
        role="tablist"
        aria-label="Rooms in your reservation"
        className="flex gap-1 overflow-x-auto overflow-y-hidden border-b border-(--bk-border)"
      >
        {cart.map((item, i) => {
          const selected = item.id === activeItem.id;
          const room = getCatalogueRoom(item.slug);
          const count = item.addonIds.length;
          return (
            <button
              key={item.id}
              id={tabId(item.id)}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={panelId}
              tabIndex={selected ? 0 : -1}
              onClick={() => setSelectedId(item.id)}
              onKeyDown={(e) => onTabKey(e, i)}
              className={`inline-flex max-w-[min(100%,26rem)] shrink-0 items-center gap-2 border-b-[3px] px-3 py-2.5 text-left text-sm font-semibold transition-colors ${
                selected ? "border-(--bk-accent) text-(--bk-text)" : "border-transparent text-(--bk-text-muted) hover:text-(--bk-text)"
              }`}
            >
              <span className="truncate">{room?.name ?? item.slug}</span>
              {count > 0 && (
                <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-(--bk-accent) px-1.5 text-[11px] text-(--bk-accent-contrast)">
                  {count}
                  <span className="bk-sr-only"> add-ons</span>
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div
        id={panelId}
        role="tabpanel"
        aria-labelledby={tabId(activeItem.id)}
        tabIndex={0}
        className="space-y-4 focus-visible:outline-offset-4"
      >
        <p className="text-xs text-(--bk-text-subtle)">
          {RATE_PLANS[activeItem.ratePlanId].name} · {activeItem.adults} {activeItem.adults === 1 ? "guest" : "guests"}
        </p>
        {ADDON_IDS.map((id) => (
          <AddonCard
            key={id}
            addon={ADDONS[id]}
            item={activeItem}
            roomName={activeRoomName}
            checkIn={checkIn}
            checkOut={checkOut}
            onToggle={() => onToggleAddon(activeItem.id, id)}
          />
        ))}
      </div>

      <div className="flex items-start gap-3 rounded-(--bk-radius-control) bg-(--bk-surface-muted) p-4">
        <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-(--bk-accent-soft) text-(--bk-accent-soft-text)">
          <Plane size={18} aria-hidden="true" />
        </span>
        <div className="text-sm">
          <p className="font-semibold text-(--bk-text)">
            Free airport pickup{" "}
            {pickupIncluded && (
              <span className="ml-1 rounded-(--bk-radius-pill) bg-(--bk-success-soft) px-2 py-0.5 text-xs font-medium text-(--bk-success)">
                Included
              </span>
            )}
          </p>
          <p className="mt-0.5 text-(--bk-text-muted)">
            {pickupIncluded
              ? "Included with your stay - send us your flight details on WhatsApp after booking and we'll meet you at Samui airport."
              : HOUSE_POLICIES.airportPickup}
          </p>
        </div>
      </div>
    </div>
  );
}
