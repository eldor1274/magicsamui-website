"use client";

// OWNER: ui-search-results
// One room in the results, Cloudbeds layout: photo carousel ("Only 1 left"),
// name, occupancy chip and quick facts, 4-line description, "View details";
// then the rate rows (Standard first, other plans behind "View offers") with
// the stay total, "N Nights" and an "Add" pill that opens the occupancy
// picker. Sold-out rooms render faded without rates; the not-bookable villa
// renders a WhatsApp enquiry instead. Keep RoomOfferCardProps stable
// (additions optional).

import { useId, useRef, useState } from "react";
import Image from "next/image";
import { BedDouble, Check, ChevronDown, ChevronRight, Info, MessageCircle, Ruler, Users, Waves } from "lucide-react";
import { RATE_PLANS } from "@/lib/booking/catalogue";
import { formatNights } from "@/lib/booking/dates";
import { formatThb } from "@/lib/booking/format";
import { percentOf, rateTotalForAdults } from "@/lib/booking/quote";
import type { CatalogueRoom, RateOffer, RatePlanId, RatePlanInfo, RoomOffer } from "@/lib/booking/types";
import { BTN_LINK, BTN_OUTLINE, BTN_PRIMARY, CHIP } from "../ui/styles";
import OccupancyPopover from "./OccupancyPopover";
import PhotoCarousel from "./PhotoCarousel";
import RatePolicyModal from "./RatePolicyModal";
import RoomDetailsModal from "./RoomDetailsModal";

export interface RoomOfferCardProps {
  room: CatalogueRoom;
  offer: RoomOffer;
  nights: number;
  /** Pre-filled adults for the occupancy popover (already capped at room.maxGuests). */
  defaultAdults: number;
  /** This room is already in the cart (grey out its Add buttons). */
  inCart: boolean;
  /** Shares a physical unit with a cart item: show this reason, disable Add. */
  blockedReason: string | null;
  /** Most guests the occupancy picker offers (default: offer.maxAdults, else room.maxGuests). */
  maxAdults?: number;
  onAdd: (ratePlanId: RatePlanId, adults: number) => void;
  /** WhatsApp link for rooms sold by enquiry only ("not-bookable"). */
  enquiryHref?: string;
  /** A valid promo from the search: rate rows show the discounted price, as the summary will. */
  promo?: { code: string; pct: number } | null;
}

export default function RoomOfferCard({
  room,
  offer,
  nights,
  defaultAdults,
  inCart,
  blockedReason,
  maxAdults: maxAdultsProp,
  onAdd,
  enquiryHref,
  promo = null,
}: RoomOfferCardProps) {
  const maxAdults = Math.max(1, maxAdultsProp ?? offer.maxAdults ?? room.maxGuests);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [policyPlan, setPolicyPlan] = useState<RatePlanInfo | null>(null);
  const [showOffers, setShowOffers] = useState(false);
  const titleId = useId();
  const ratesId = useId();

  const soldOut = !offer.available && offer.unavailableReason === "sold-out";
  const enquiryOnly = offer.unavailableReason === "not-bookable";
  const bookable = offer.available && !enquiryOnly;
  const addDisabledReason = inCart ? "Already in your reservation" : blockedReason;
  const visibleRates = showOffers ? offer.rates : offer.rates.slice(0, 1);
  const hiddenCount = offer.rates.length - 1;

  const badge = soldOut ? (
    <span className="rounded-(--bk-radius-pill) bg-(--bk-surface) px-2.5 py-1 text-xs font-semibold text-(--bk-danger) shadow-(--bk-shadow-card)">
      Sold Out
    </span>
  ) : enquiryOnly ? (
    <span className="rounded-(--bk-radius-pill) bg-(--bk-surface) px-2.5 py-1 text-xs font-semibold text-(--bk-text) shadow-(--bk-shadow-card)">
      On request
    </span>
  ) : bookable && offer.remaining === 1 && !inCart && !blockedReason ? (
    <span className="rounded-(--bk-radius-pill) bg-(--bk-surface) px-2.5 py-1 text-xs font-semibold text-(--bk-text) shadow-(--bk-shadow-card)">
      Only 1 left
    </span>
  ) : inCart ? (
    <span className="inline-flex items-center gap-1 rounded-(--bk-radius-pill) bg-(--bk-accent) px-2.5 py-1 text-xs font-semibold text-(--bk-accent-contrast) shadow-(--bk-shadow-card)">
      <Check size={12} aria-hidden="true" />
      In your reservation
    </span>
  ) : null;

  return (
    <article
      aria-labelledby={titleId}
      className="overflow-hidden rounded-(--bk-radius-card) bg-(--bk-surface) text-(--bk-text) shadow-(--bk-shadow-card)"
    >
      <div className="grid gap-4 p-3 sm:grid-cols-[minmax(0,44%)_minmax(0,1fr)] sm:p-4">
        <PhotoCarousel
          photos={room.gallery}
          label={room.name}
          badge={badge}
          muted={soldOut}
          sizes="(min-width: 1024px) 300px, (min-width: 640px) 44vw, 100vw"
        />

        <div className="flex min-w-0 flex-col">
          <h3 id={titleId} className={`bk-heading text-lg leading-snug sm:text-xl ${soldOut ? "text-(--bk-text-muted)" : ""}`}>
            {room.name}
          </h3>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <span className={CHIP} aria-label={`Accommodates ${room.maxGuests} guests`}>
              <Users size={14} aria-hidden="true" />
              {room.maxGuests}
            </span>
            <span className={CHIP}>
              <BedDouble size={14} aria-hidden="true" />
              {room.bedrooms} BR
            </span>
            <span className={CHIP}>
              <Ruler size={14} aria-hidden="true" />
              {room.areaSqm} m²
            </span>
            {room.hasPool && room.poolType && (
              <span className={`${CHIP} max-w-full`}>
                <Waves size={14} className="shrink-0" aria-hidden="true" />
                <span className="truncate">{room.poolType}</span>
              </span>
            )}
          </div>
          <p className="mt-3 line-clamp-4 text-sm leading-relaxed text-(--bk-text-muted)">{room.summary}</p>
          <div className="mt-auto pt-3">
            <button
              type="button"
              onClick={() => setDetailsOpen(true)}
              aria-haspopup="dialog"
              aria-label={`View details, ${room.name}`}
              className={`${BTN_LINK} text-sm`}
            >
              View details
            </button>
          </div>
        </div>
      </div>

      {bookable && (
        <>
          {(addDisabledReason || !offer.fitsParty || maxAdults < room.maxGuests) && (
            <div className="space-y-1 px-4 pb-3">
              {addDisabledReason && !inCart && (
                <p className="flex items-start gap-2 rounded-(--bk-radius-control) bg-(--bk-warning-soft) px-3 py-2 text-sm text-(--bk-text)">
                  <Info size={16} className="mt-0.5 shrink-0 text-(--bk-warning)" aria-hidden="true" />
                  <span>
                    {addDisabledReason.startsWith("Shares space")
                      ? `${addDisabledReason}. It can't be booked together with that room.`
                      : addDisabledReason}
                  </span>
                </p>
              )}
              {!addDisabledReason && (!offer.fitsParty || maxAdults < room.maxGuests) && (
                <p className="flex items-start gap-2 text-sm text-(--bk-text-muted)">
                  <Info size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                  {maxAdults < room.maxGuests
                    ? `Online booking for up to ${maxAdults} ${maxAdults === 1 ? "guest" : "guests"}. Message us for a bigger group.`
                    : `Sleeps up to ${maxAdults}. Add another room for the rest of your group.`}
                </p>
              )}
            </div>
          )}

          <ul id={ratesId} aria-label={`Rates for ${room.name}`} className="border-t border-(--bk-border)">
            {visibleRates.map((rate) => (
              <RateRow
                key={rate.ratePlanId}
                room={room}
                rate={rate}
                nights={nights}
                defaultAdults={Math.min(defaultAdults, maxAdults)}
                maxAdults={maxAdults}
                disabledReason={addDisabledReason}
                promo={promo}
                onShowPolicy={() => setPolicyPlan(RATE_PLANS[rate.ratePlanId])}
                onAdd={(adults) => onAdd(rate.ratePlanId, adults)}
              />
            ))}
          </ul>

          {hiddenCount > 0 && (
            <button
              type="button"
              onClick={() => setShowOffers((v) => !v)}
              aria-expanded={showOffers}
              aria-controls={ratesId}
              aria-label={`${showOffers ? "Hide" : "View"} offers, ${room.name}`}
              className="flex w-full items-center justify-center gap-1.5 bg-(--bk-offers-bar) py-3 text-sm font-medium text-(--bk-offers-bar-text) transition-colors hover:brightness-95"
            >
              {showOffers ? "Hide offers" : "View offers"}
              <ChevronDown size={16} className={`transition-transform ${showOffers ? "rotate-180" : ""}`} aria-hidden="true" />
            </button>
          )}
        </>
      )}

      {enquiryOnly && (
        <div className="flex flex-col gap-3 border-t border-(--bk-border) px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-(--bk-text-muted)">
            The whole villa with its lower seaview unit is booked by message. We&apos;ll check your dates and send you a quote.
          </p>
          {enquiryHref && (
            <a href={enquiryHref} target="_blank" rel="noopener noreferrer" className={`${BTN_OUTLINE} h-11 shrink-0 text-sm`}>
              <MessageCircle size={16} aria-hidden="true" />
              Enquire on WhatsApp
            </a>
          )}
        </div>
      )}

      <RoomDetailsModal room={room} open={detailsOpen} onClose={() => setDetailsOpen(false)} />
      {policyPlan && <RatePolicyModal room={room} ratePlan={policyPlan} open onClose={() => setPolicyPlan(null)} />}
    </article>
  );
}

interface RateRowProps {
  room: CatalogueRoom;
  rate: RateOffer;
  nights: number;
  defaultAdults: number;
  maxAdults: number;
  disabledReason: string | null;
  promo: { code: string; pct: number } | null;
  onShowPolicy: () => void;
  onAdd: (adults: number) => void;
}

function RateRow({ room, rate, nights, defaultAdults, maxAdults, disabledReason, promo, onShowPolicy, onAdd }: RateRowProps) {
  const [picking, setPicking] = useState(false);
  const addRef = useRef<HTMLButtonElement>(null);
  const plan = RATE_PLANS[rate.ratePlanId];
  const hasDetails = plan.image !== null || plan.policy.length > 0;
  const perGuest = rate.supplementSatangPerGuestPerNight > 0;
  const total = rateTotalForAdults(rate, defaultAdults);
  // Same satang rounding as the quote's promo line (quote.ts), so card, summary and server agree.
  const discounted = promo ? total - percentOf(total, promo.pct) : total;

  return (
    <li className="border-b border-(--bk-border) last:border-b-0">
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-3 px-4 py-3.5 sm:grid-cols-[auto_minmax(0,1fr)_auto_auto]">
        {plan.image ? (
          <button
            type="button"
            onClick={onShowPolicy}
            aria-label={`View details for ${plan.name}`}
            className="relative h-14 w-20 shrink-0 overflow-hidden rounded-(--bk-radius-control) bg-(--bk-surface-sunken) sm:h-16 sm:w-28"
          >
            <Image src={plan.image.src} alt="" fill sizes="112px" className="object-cover" />
          </button>
        ) : null}

        <div className={`min-w-0 ${plan.image ? "" : "col-span-2"}`}>
          {hasDetails ? (
            <button
              type="button"
              onClick={onShowPolicy}
              aria-haspopup="dialog"
              className="inline-flex items-center gap-1 text-left font-semibold underline decoration-1 underline-offset-4 hover:text-(--bk-accent)"
            >
              {rate.ratePlanName}
              <ChevronRight size={16} aria-hidden="true" />
            </button>
          ) : (
            <p className="font-semibold">{rate.ratePlanName}</p>
          )}
          <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-(--bk-text-muted)">{plan.shortDescription}</p>
        </div>

        <div className="col-span-2 flex items-center justify-between gap-4 sm:contents">
          <div className="sm:text-right">
            {promo && (
              <p className="bk-price text-xs leading-tight text-(--bk-text-subtle) line-through">
                <span className="bk-sr-only">Was </span>
                {formatThb(total)}
              </p>
            )}
            <p className="bk-price text-lg font-semibold leading-tight">
              {promo && <span className="bk-sr-only">Now </span>}
              {formatThb(discounted)}
            </p>
            <p className="text-xs text-(--bk-text-muted)">
              {formatNights(nights)}
              {perGuest && ` · ${defaultAdults} ${defaultAdults === 1 ? "guest" : "guests"}`}
            </p>
            {promo && (
              <p className="text-xs font-medium text-(--bk-success)">
                incl. {promo.code} −{promo.pct}%
              </p>
            )}
          </div>
          <button
            ref={addRef}
            type="button"
            onClick={() => {
              if (!disabledReason) setPicking((v) => !v);
            }}
            aria-disabled={disabledReason ? true : undefined}
            aria-haspopup="dialog"
            aria-expanded={picking}
            aria-label={`Add ${rate.ratePlanName}, ${room.name}${disabledReason ? ` (${disabledReason})` : ""}`}
            title={disabledReason ?? undefined}
            className={`${BTN_PRIMARY} h-11 min-w-20 text-sm`}
          >
            Add
          </button>
        </div>
      </div>

      <OccupancyPopover
        open={picking}
        onClose={() => setPicking(false)}
        onConfirm={onAdd}
        roomName={room.name}
        ratePlanName={rate.ratePlanName}
        maxAdults={maxAdults}
        defaultAdults={defaultAdults}
        anchorRef={addRef}
      />
    </li>
  );
}
