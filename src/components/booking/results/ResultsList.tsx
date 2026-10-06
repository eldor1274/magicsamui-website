"use client";

// OWNER: ui-search-results
// "Choose your room" list. Order: bookable rooms (those that fit the whole
// party first; rooms clashing with the cart stay listed with their reason),
// the enquiry-only villa, then sold-out rooms in a faded section behind a
// "Show more options" toggle. Skeleton cards reserve space while loading; a
// re-search dims the current list instead of emptying it. Error and "fully
// booked" states offer Retry / Change dates / WhatsApp, and the house
// policies close the list. Keep ResultsListProps stable.

import { useId, useState } from "react";
import { AlertTriangle, CalendarX2, ChevronDown, Loader2, MessageCircle, RotateCcw } from "lucide-react";
import { site } from "@/data/site";
import { HOUSE_POLICIES, getCatalogueRoom } from "@/lib/booking/catalogue";
import { formatNights, formatStayRange } from "@/lib/booking/dates";
import type { AvailabilityResponse, CartItem, RatePlanId, RoomOffer } from "@/lib/booking/types";
import type { AsyncStatus } from "../state";
import { BTN_OUTLINE, BTN_PRIMARY, TOUCH_TARGET } from "../ui/styles";
import RoomOfferCard from "./RoomOfferCard";

export interface ResultsListProps {
  availability: AvailabilityResponse | null;
  status: AsyncStatus;
  error: string | null;
  cart: CartItem[];
  /** Guests from the search bar (pre-fills the occupancy popover, capped per room). */
  searchAdults: number;
  /** Reason a slug can't be added next to the cart (shared physical unit), or null. */
  blockedReason: (slug: string) => string | null;
  /**
   * Most guests the occupancy picker may offer for a room (the offer's limit,
   * lowered after the checkout refused a party size). Default: the offer's limit.
   */
  maxAdultsFor?: (slug: string, offerMax: number | undefined) => number;
  onAdd: (input: { slug: string; ratePlanId: RatePlanId; adults: number }) => void;
  onRetry: () => void;
  /** Opens the date picker / scrolls to the search bar. */
  onChangeDates: () => void;
}

function whatsappHref(text: string): string {
  return `${site.whatsapp}?text=${encodeURIComponent(text)}`;
}

export default function ResultsList({
  availability,
  status,
  error,
  cart,
  searchAdults,
  blockedReason,
  maxAdultsFor,
  onAdd,
  onRetry,
  onChangeDates,
}: ResultsListProps) {
  const [showSoldOut, setShowSoldOut] = useState(false);
  const soldOutId = useId();

  if (!availability) {
    if (status === "error") return <AvailabilityErrorCard message={error} onRetry={onRetry} onChangeDates={onChangeDates} />;
    return <LoadingList />;
  }

  const { search, nights, offers } = availability;
  // Every online payment adds this fee (cards, wallets and PromptPay alike): said with the first prices shown.
  const feePct = availability.config.cardFeePct;
  const stay = formatStayRange(search.checkIn, search.checkOut);
  const refreshing = status === "loading";

  const bookable = offers.filter((o) => o.available && o.unavailableReason === null);
  // Rooms that sleep the whole party come first; the rest keep catalogue order.
  const available = [...bookable.filter((o) => o.fitsParty), ...bookable.filter((o) => !o.fitsParty)];
  const enquiry = offers.filter((o) => o.unavailableReason === "not-bookable");
  const soldOut = offers.filter((o) => !o.available && o.unavailableReason !== "not-bookable");
  const bookableTotal = available.length + soldOut.length;
  const noneFitsParty = available.length > 0 && available.every((o) => !o.fitsParty);

  const renderCard = (offer: RoomOffer) => {
    const room = getCatalogueRoom(offer.slug);
    if (!room) return null;
    const maxAdults = maxAdultsFor ? maxAdultsFor(offer.slug, offer.maxAdults) : (offer.maxAdults ?? room.maxGuests);
    return (
      <li key={offer.slug}>
        <RoomOfferCard
          room={room}
          offer={offer}
          nights={nights}
          defaultAdults={Math.max(1, Math.min(searchAdults, maxAdults))}
          maxAdults={maxAdults}
          inCart={cart.some((c) => c.slug === offer.slug)}
          blockedReason={blockedReason(offer.slug)}
          onAdd={(ratePlanId, adults) => onAdd({ slug: offer.slug, ratePlanId, adults })}
          promo={availability.promo?.valid ? { code: availability.promo.code, pct: availability.promo.pct } : null}
          feePct={feePct}
          enquiryHref={
            offer.unavailableReason === "not-bookable"
              ? whatsappHref(
                  `Hi, I'd like to enquire about the ${room.name} for ${formatStayRange(search.checkIn, search.checkOut, " to ")} (${search.adults} guests).`,
                )
              : undefined
          }
        />
      </li>
    );
  };

  return (
    <div className="space-y-4" aria-busy={refreshing || undefined}>
      {/* Summary line on the page frame */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-1 text-(--bk-frame-text)">
        <p className="text-sm">
          <span className="font-semibold">
            {available.length} of {bookableTotal} {bookableTotal === 1 ? "room" : "rooms"} available
          </span>
          <span className="text-(--bk-frame-text-muted)">
            {" "}
            · {stay} · {formatNights(nights)} · {search.adults} {search.adults === 1 ? "guest" : "guests"}
          </span>
          {feePct > 0 && (
            <span className="block text-(--bk-frame-text-muted)">
              Prices are for the stay; a {feePct}% payment processing fee is added to every online payment.
            </span>
          )}
        </p>
        <button
          type="button"
          onClick={onChangeDates}
          className={`${TOUCH_TARGET} rounded-sm text-sm font-medium underline decoration-1 underline-offset-4 hover:no-underline`}
        >
          Change search
        </button>
      </div>

      {/* Always rendered with a fixed height, so the cards don't jump down and back up on every re-search. */}
      <p role="status" className="flex h-5 items-center gap-2 px-1 text-sm text-(--bk-frame-text)">
        {refreshing && (
          <>
            <Loader2 size={16} className="animate-spin" aria-hidden="true" />
            Updating availability and prices…
          </>
        )}
      </p>

      {status === "error" && <AvailabilityErrorCard message={error} onRetry={onRetry} onChangeDates={onChangeDates} />}

      <div className={`space-y-4 transition-opacity ${refreshing ? "pointer-events-none opacity-60" : ""}`}>
        {noneFitsParty && (
          <p className="rounded-(--bk-radius-card) bg-(--bk-surface) px-4 py-3 text-sm text-(--bk-text) shadow-(--bk-shadow-card)">
            No single room sleeps {search.adults} guests on these dates. Add several rooms to one reservation, or{" "}
            <a
              href={whatsappHref(`Hi, we're a group of ${search.adults} looking at ${stay}. Can you help?`)}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-(--bk-link) underline underline-offset-4"
            >
              message us on WhatsApp
            </a>{" "}
            and we&apos;ll put a group stay together.
          </p>
        )}

        {available.length === 0 && (
          <FullyBooked stay={stay} onChangeDates={onChangeDates} whatsapp={whatsappHref(`Hi, is anything free around ${stay}?`)} />
        )}

        {available.length > 0 && (
          <ul className="space-y-4" aria-label="Available rooms">
            {available.map(renderCard)}
          </ul>
        )}

        {enquiry.length > 0 && (
          <ul className="space-y-4" aria-label="Available on request">
            {enquiry.map(renderCard)}
          </ul>
        )}

        {soldOut.length > 0 && (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <span className="h-px flex-1 bg-(--bk-frame-text-muted) opacity-40" aria-hidden="true" />
              <button
                type="button"
                onClick={() => setShowSoldOut((v) => !v)}
                aria-expanded={showSoldOut}
                aria-controls={soldOutId}
                className={`${BTN_PRIMARY} h-11 px-5 text-sm`}
              >
                {showSoldOut ? "Hide more options" : "Show more options"}
                <span className="bk-sr-only"> ({soldOut.length} sold out for these dates)</span>
                <ChevronDown size={16} className={`transition-transform ${showSoldOut ? "rotate-180" : ""}`} aria-hidden="true" />
              </button>
              <span className="h-px flex-1 bg-(--bk-frame-text-muted) opacity-40" aria-hidden="true" />
            </div>
            <div id={soldOutId} hidden={!showSoldOut}>
              {showSoldOut && (
                <>
                  <p className="mb-3 px-1 text-sm text-(--bk-frame-text-muted)">
                    Sold out for {stay}. Different dates may open these up.
                  </p>
                  <ul className="space-y-4" aria-label="Sold out rooms">
                    {soldOut.map(renderCard)}
                  </ul>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      <HousePolicies />
    </div>
  );
}

/* --------------------------------- states --------------------------------- */

function LoadingList() {
  return (
    <div aria-busy="true" className="space-y-4">
      <p role="status" className="flex items-center gap-2 px-1 text-sm text-(--bk-frame-text)">
        <Loader2 size={16} className="animate-spin" aria-hidden="true" />
        Checking availability…
      </p>
      {[0, 1, 2].map((i) => (
        <div key={i} className="overflow-hidden rounded-(--bk-radius-card) bg-(--bk-surface) shadow-(--bk-shadow-card)" aria-hidden="true">
          <div className="grid gap-4 p-3 sm:grid-cols-[minmax(0,44%)_minmax(0,1fr)] sm:p-4">
            <div className="aspect-[4/3] animate-pulse rounded-(--bk-radius-control) bg-(--bk-surface-sunken)" />
            <div className="space-y-3 py-1">
              <div className="h-5 w-4/5 animate-pulse rounded bg-(--bk-surface-sunken)" />
              <div className="flex gap-2">
                <div className="h-6 w-10 animate-pulse rounded bg-(--bk-surface-sunken)" />
                <div className="h-6 w-14 animate-pulse rounded bg-(--bk-surface-sunken)" />
                <div className="h-6 w-16 animate-pulse rounded bg-(--bk-surface-sunken)" />
              </div>
              <div className="h-3.5 w-full animate-pulse rounded bg-(--bk-surface-sunken)" />
              <div className="h-3.5 w-11/12 animate-pulse rounded bg-(--bk-surface-sunken)" />
              <div className="h-3.5 w-3/4 animate-pulse rounded bg-(--bk-surface-sunken)" />
            </div>
          </div>
          <div className="flex items-center justify-between border-t border-(--bk-border) px-4 py-4">
            <div className="h-5 w-32 animate-pulse rounded bg-(--bk-surface-sunken)" />
            <div className="h-10 w-20 animate-pulse rounded-(--bk-radius-pill) bg-(--bk-surface-sunken)" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function AvailabilityErrorCard({ message, onRetry, onChangeDates }: { message: string | null; onRetry: () => void; onChangeDates: () => void }) {
  return (
    <div role="alert" className="rounded-(--bk-radius-card) bg-(--bk-surface) p-5 text-(--bk-text) shadow-(--bk-shadow-card)">
      <div className="flex items-start gap-3">
        <AlertTriangle size={20} className="mt-0.5 shrink-0 text-(--bk-danger)" aria-hidden="true" />
        <div className="min-w-0">
          <p className="font-semibold">We couldn&apos;t load availability</p>
          <p className="mt-1 text-sm text-(--bk-text-muted)">{message || "Something went wrong. Please try again."}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" onClick={onRetry} className={`${BTN_PRIMARY} h-11 text-sm`}>
              <RotateCcw size={16} aria-hidden="true" />
              Retry
            </button>
            <button type="button" onClick={onChangeDates} className={`${BTN_OUTLINE} h-11 text-sm`}>
              Change dates
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function FullyBooked({ stay, onChangeDates, whatsapp }: { stay: string; onChangeDates: () => void; whatsapp: string }) {
  return (
    <div className="rounded-(--bk-radius-card) bg-(--bk-surface) p-6 text-center text-(--bk-text) shadow-(--bk-shadow-card)">
      <CalendarX2 size={32} className="mx-auto text-(--bk-text-subtle)" aria-hidden="true" />
      <p className="bk-heading mt-3 text-xl">Fully booked for these dates</p>
      <p className="mx-auto mt-2 max-w-md text-sm text-(--bk-text-muted)">
        Every room is taken for {stay}. Try moving your stay by a day or two, or message us and we&apos;ll help you find dates.
      </p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        <button type="button" onClick={onChangeDates} className={`${BTN_PRIMARY} h-11 text-sm`}>
          Change dates
        </button>
        <a href={whatsapp} target="_blank" rel="noopener noreferrer" className={`${BTN_OUTLINE} h-11 text-sm`}>
          <MessageCircle size={16} aria-hidden="true" />
          WhatsApp us
        </a>
      </div>
    </div>
  );
}

function HousePolicies() {
  return (
    <section aria-labelledby="house-policies-heading" className="rounded-(--bk-radius-card) bg-(--bk-surface) p-5 text-(--bk-text) shadow-(--bk-shadow-card)">
      <h3 id="house-policies-heading" className="bk-heading text-lg">
        Good to know
      </h3>
      <dl className="mt-3 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="font-medium">Check-in / check-out</dt>
          <dd className="text-(--bk-text-muted)">
            {HOUSE_POLICIES.checkIn} · {HOUSE_POLICIES.checkOut}
          </dd>
        </div>
        <div>
          <dt className="font-medium">Airport pickup</dt>
          <dd className="text-(--bk-text-muted)">{HOUSE_POLICIES.airportPickup}</dd>
        </div>
        <div>
          <dt className="font-medium">Cancellation</dt>
          <dd className="text-(--bk-text-muted)">{HOUSE_POLICIES.cancellation}</dd>
        </div>
        <div>
          <dt className="font-medium">Children</dt>
          <dd className="text-(--bk-text-muted)">{HOUSE_POLICIES.children}</dd>
        </div>
      </dl>
    </section>
  );
}
