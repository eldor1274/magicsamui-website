// OWNER: foundation. Booking flow state: reducer, selectors, persistence and
// the React context. UI components read it with useBooking() or receive
// props from BookingApp. Change the contract only through the foundation.

import { createContext, useContext } from "react";
import type { Dispatch } from "react";
import { ADDONS, POLICY_VERSION, cartConflict, getCatalogueRoom, hasUnitConflict, isAddonId, isBookableSlug, isRatePlanId } from "@/lib/booking/catalogue";
import type { BookingAnalytics } from "@/lib/booking/clientAnalytics";
import { isRestrictionMessage } from "@/lib/booking/checkoutMessages";
import { isIsoDate } from "@/lib/booking/dates";
import { EMPTY_GUEST, isGuestValid } from "@/lib/booking/guest";
import type { GuestDetails } from "@/lib/booking/guest";
import { QuoteError, addonEligibleNights, computeQuote } from "@/lib/booking/quote";
import type { ResumeReason } from "@/lib/booking/urls";
import type {
  AddonId,
  ApiError,
  AvailabilityResponse,
  BookingErrorCode,
  CartItem,
  CartItemInput,
  IsoDate,
  PublicBookingConfig,
  Quote,
  RatePlanId,
  ThemeName,
} from "@/lib/booking/types";

/* ------------------------------- steps ------------------------------- */

export type Step = "search" | "results" | "addons" | "guest" | "payment";

export const STEP_ORDER: Step[] = ["search", "results", "addons", "guest", "payment"];

export const STEP_TITLES: Record<Step, string> = {
  search: "Book your stay",
  results: "Choose your room",
  addons: "Add-ons and Extras",
  guest: "Add Guests",
  payment: "Review and pay",
};

/** Label of the summary / mobile bar CTA on each step. */
export const STEP_CTA: Record<Step, string> = {
  search: "Search",
  results: "Book Now",
  addons: "Continue",
  guest: "Continue",
  payment: "Pay securely",
};

/** id of the guest <form>; the summary CTA submits it with form="guest-form". */
export const GUEST_FORM_ID = "guest-form";

/* ------------------------------- state ------------------------------- */

export interface SearchDraft {
  checkIn: IsoDate | null;
  checkOut: IsoDate | null;
  adults: number;
  /** Promo code as typed ("" = none). */
  promo: string;
}

export type AsyncStatus = "idle" | "loading" | "ready" | "error";

export interface ResultsState {
  status: AsyncStatus;
  data: AvailabilityResponse | null;
  error: string | null;
  /** searchKey() of the request in flight / last loaded. */
  requestKey: string | null;
}

export interface CheckoutErrorView {
  code: BookingErrorCode;
  message: string;
  /** For price_changed: the new total the server quoted. */
  newTotalSatang?: number;
  /** For price_changed: the new amount due now (deposit) the server quoted. */
  newDueNowSatang?: number;
  /** For unavailable: rooms that were just sold. */
  unavailableSlugs?: string[];
  /** For unavailable: rooms refused only for the party size (fewer guests may work). */
  occupancySlugs?: string[];
  /** For invalid_request: what exactly the server rejected (e.g. "Check-in can't be in the past."). */
  issues?: string[];
  /** For invalid_request: the step where the guest can fix it. */
  fixStep?: "addons";
  /** For rate_limited: roughly how long to wait. */
  retryAfterMinutes?: number;
}

export interface CheckoutState {
  status: "idle" | "submitting" | "redirecting" | "error";
  error: CheckoutErrorView | null;
}

export type NoticeKind = "payment-cancelled" | "payment-failed" | "cart-cleared" | "rooms-removed" | "info";


const RESUME_NOTICES: Record<ResumeReason, { kind: NoticeKind; message: string }> = {
  cancelled: { kind: "payment-cancelled", message: "Payment cancelled - nothing was charged. Your reservation is still here." },
  failed: { kind: "payment-failed", message: "The payment didn't go through - nothing was charged. You can try again below." },
  expired: { kind: "payment-failed", message: "The payment link expired - nothing was charged. You can pay again below." },
  unverified: {
    kind: "info",
    message: "Your reservation is still here. If you've already paid, please message us before paying again.",
  },
};

/** Stripe's back link: the session was expired and the Cloudbeds hold released - the room is NOT held any more. */
const STRIPE_CANCELLED_NOTICE: { kind: NoticeKind; message: string } = {
  kind: "payment-cancelled",
  message: "Payment cancelled - nothing was charged. Your selection is saved, but the room is no longer held - pay again to reserve it.",
};

export interface Notice {
  kind: NoticeKind;
  message: string;
}

/** The server's authoritative quote after a price_changed answer, for one exact cart. */
export interface ServerQuote {
  /** pricingKey() of the cart it priced; ignored as soon as the cart, dates or promo change. */
  key: string;
  quote: Quote;
}

/** Rooms the checkout refused for these dates. */
export interface RefusedRooms {
  datesKey: string;
  /** Sold: not offered again for these dates. */
  slugs: string[];
  /**
   * Refused only for a party size (Cloudbeds occupancy limit): slug -> the
   * smallest refused number of guests. Fewer guests can still be added.
   */
  occupancy?: Record<string, number>;
}

export interface BookingState {
  step: Step;
  search: SearchDraft;
  results: ResultsState;
  cart: CartItem[];
  /** "checkIn|checkOut" the cart was priced for; a new date search clears the cart. */
  cartKey: string | null;
  guest: GuestDetails;
  /** Show guest field errors (after the first submit attempt). */
  guestSubmitted: boolean;
  checkout: CheckoutState;
  notice: Notice | null;
  /**
   * After a price_changed answer the server's quote is what the guest sees
   * and pays against (see selectQuote), so a structural difference between
   * the browser's and the server's pricing can never deadlock the flow.
   */
  serverQuote: ServerQuote | null;
  /** Rooms the server just refused at checkout: removed from the cart and not offered again for these dates. */
  refused: RefusedRooms | null;
  /**
   * Fingerprint of the one-shot landing URL (?checkin.. / ?resume..) that was
   * already applied. Persisted, so a remount with the same (stale) URL - e.g.
   * the App Router replaying a cached page on browser Back - never replays it.
   */
  landingKey: string | null;
  hydrated: boolean;
}

export const DEFAULT_ADULTS = 2;

export function initialBookingState(): BookingState {
  return {
    step: "search",
    search: { checkIn: null, checkOut: null, adults: DEFAULT_ADULTS, promo: "" },
    results: { status: "idle", data: null, error: null, requestKey: null },
    cart: [],
    cartKey: null,
    guest: EMPTY_GUEST,
    guestSubmitted: false,
    checkout: { status: "idle", error: null },
    notice: null,
    serverQuote: null,
    refused: null,
    landingKey: null,
    hydrated: false,
  };
}

/** Identifies an availability request. */
export function searchKey(s: { checkIn: IsoDate | null; checkOut: IsoDate | null; adults: number; promo: string }): string {
  return `${s.checkIn ?? ""}|${s.checkOut ?? ""}|${s.adults}|${s.promo.trim().toUpperCase()}`;
}

export function datesKey(s: { checkIn: IsoDate | null; checkOut: IsoDate | null }): string {
  return `${s.checkIn ?? ""}|${s.checkOut ?? ""}`;
}

/* ------------------------------ actions ------------------------------ */

export interface PersistedBooking {
  v: 1;
  step: Step;
  search: SearchDraft;
  cart: CartItem[];
  cartKey: string | null;
  guest: GuestDetails;
  /** See BookingState.landingKey. */
  landingKey: string | null;
  /** The terms version (POLICY_VERSION) this page showed when it saved guest.agreedToPolicy; consent to other terms is dropped. */
  termsVersion?: string;
  savedAt: string;
}

export type BookingAction =
  | {
      type: "hydrate";
      persisted: PersistedBooking | null;
      /** Valid ?checkin/?checkout/?adults/?promo from the URL (wins over persisted search). */
      initialSearch: Partial<SearchDraft> | null;
      /** "payment" when Beam's cancel button (or the return page) sent the guest back. */
      resume: "payment" | null;
      /** Why the guest is back on the payment step (default "cancelled"). */
      resumeReason?: ResumeReason | null;
      /** Stripe's back link: the hold is being released (the notice must not say the room is still held). */
      holdReleased?: boolean;
      /** Fingerprint of this page load's one-shot URL params (null when there are none). */
      landingKey?: string | null;
      today: IsoDate;
    }
  | { type: "setSearch"; patch: Partial<SearchDraft> }
  | { type: "searchStarted"; key: string }
  | { type: "searchSucceeded"; key: string; data: AvailabilityResponse }
  | { type: "searchFailed"; key: string; message: string }
  | { type: "addToCart"; item: CartItem }
  | { type: "removeFromCart"; id: string }
  | { type: "toggleAddon"; itemId: string; addonId: AddonId }
  | { type: "updateGuest"; patch: Partial<GuestDetails> }
  | { type: "guestSubmitted" }
  | { type: "goToStep"; step: Step }
  | { type: "checkoutStarted" }
  | {
      type: "checkoutFailed";
      error: CheckoutErrorView;
      /** price_changed: the server's fresh quote for exactly this cart. */
      quote?: Quote;
    }
  | { type: "checkoutRedirecting" }
  /** The page came back from the back/forward cache after the redirect: unlock Pay. */
  | { type: "checkoutReset" }
  | { type: "setNotice"; notice: Notice | null }
  | { type: "reset" };

/* ------------------------------ reducer ------------------------------ */

/** Whether the flow may show `step` for this state (also used to vet browser Back/Forward). */
export function canEnter(step: Step, state: Pick<BookingState, "search" | "cart" | "guest">): boolean {
  switch (step) {
    case "search":
      return true;
    case "results":
      return state.search.checkIn !== null && state.search.checkOut !== null;
    case "addons":
    case "guest":
      return state.cart.length > 0;
    case "payment":
      // Never reachable (e.g. via browser Forward) without valid guest details and policy consent.
      return state.cart.length > 0 && isGuestValid(state.guest);
  }
}

export function bookingReducer(state: BookingState, action: BookingAction): BookingState {
  switch (action.type) {
    case "hydrate": {
      const base = initialBookingState();
      const p = action.persisted;
      const usable = p && p.v === 1 && (!p.search.checkIn || p.search.checkIn >= action.today) ? p : null;
      let search: SearchDraft = usable ? { ...base.search, ...usable.search } : base.search;
      let cart = usable?.cart ?? [];
      let cartKey = usable?.cartKey ?? null;
      let step: Step = usable?.step ?? "search";
      let notice: Notice | null = null;
      // The same landing URL seen again (Back to a cached page, bfcache, a
      // reload the address-bar cleanup missed) was already applied once.
      const landingKey = action.landingKey ?? null;
      const alreadyApplied = landingKey !== null && usable?.landingKey === landingKey;
      const initialSearch = alreadyApplied ? null : action.initialSearch;
      const resume = alreadyApplied ? null : action.resume;
      // The double-payment warning is shown whenever it is asked for, even on
      // a replayed URL: it costs nothing and may stop a second charge.
      const unverifiedWarning = action.resume === "payment" && action.resumeReason === "unverified";

      if (initialSearch) {
        const next = { ...search, ...initialSearch };
        const sameDates = datesKey(next) === datesKey(search);
        if (!sameDates && cart.length > 0) {
          cart = [];
          cartKey = null;
          notice = { kind: "cart-cleared", message: "Your dates changed, so your previous room selection was cleared." };
        }
        search = next;
        // A reload of a prefilled URL keeps the guest on their current step.
        if (!sameDates || step === "search") step = next.checkIn && next.checkOut ? "results" : "search";
      }
      const guest = usable?.guest ?? base.guest;
      if (resume === "payment" && cart.length > 0) {
        step = "payment";
        const reason = action.resumeReason ?? "cancelled";
        notice = action.holdReleased && reason === "cancelled" ? STRIPE_CANCELLED_NOTICE : RESUME_NOTICES[reason];
      } else if (unverifiedWarning) {
        notice = RESUME_NOTICES.unverified;
      }
      const hasDates = Boolean(search.checkIn && search.checkOut);
      // A saved cart without complete dates can never be priced: start again from the search.
      if (cart.length > 0 && !hasDates) {
        cart = [];
        cartKey = null;
        step = "search";
      }
      if (step !== "search" && step !== "results" && cart.length === 0) step = hasDates ? "results" : "search";
      if (step === "payment" && !isGuestValid(guest)) step = "guest";
      if (step === "results" && !hasDates) step = "search";
      return {
        ...base,
        step,
        search,
        cart,
        cartKey,
        guest,
        notice,
        landingKey: landingKey ?? usable?.landingKey ?? null,
        hydrated: true,
      };
    }

    case "setSearch":
      return { ...state, search: { ...state.search, ...action.patch } };

    case "searchStarted":
      return {
        ...state,
        step: state.step === "search" ? "results" : state.step,
        results: { ...state.results, status: "loading", error: null, requestKey: action.key },
      };

    case "searchSucceeded": {
      if (action.key !== state.results.requestKey) return state; // stale response
      const data = action.data;
      const dk = datesKey({ checkIn: data.search.checkIn, checkOut: data.search.checkOut });
      let cart = state.cart;
      let notice = state.notice;
      if (state.cartKey !== null && state.cartKey !== dk && cart.length > 0) {
        cart = [];
        notice = { kind: "cart-cleared", message: "New dates - please choose your room again." };
      }
      const stillOk = cart.filter((item) => {
        const offer = data.offers.find((o) => o.slug === item.slug);
        return offer?.available === true && offer.rates.some((r) => r.ratePlanId === item.ratePlanId);
      });
      if (stillOk.length !== cart.length) {
        notice = { kind: "rooms-removed", message: "A room in your reservation is no longer available and was removed." };
      }
      // Add-ons that no longer fit this stay or rate (catalogue changed between
      // deploys, or edited storage) would price at 0 and then fail at Pay.
      let addonsDropped = false;
      const kept = stillOk.map((item) => {
        const addonIds = item.addonIds.filter(
          (a) =>
            ADDONS[a]?.ratePlans.includes(item.ratePlanId) === true &&
            addonEligibleNights(ADDONS[a], data.search.checkIn, data.search.checkOut).length > 0,
        );
        if (addonIds.length === item.addonIds.length) return item;
        addonsDropped = true;
        return { ...item, addonIds };
      });
      if (addonsDropped && stillOk.length === cart.length) {
        notice = { kind: "rooms-removed", message: "An add-on isn't available for your dates and was removed from your reservation." };
      }
      const step = stillOk.length === 0 && state.step !== "search" && state.step !== "results" ? "results" : state.step;
      return {
        ...state,
        step,
        cart: kept,
        cartKey: dk,
        notice,
        refused: state.refused?.datesKey === dk ? state.refused : null,
        results: { status: "ready", data, error: null, requestKey: action.key },
      };
    }

    case "searchFailed":
      if (action.key !== state.results.requestKey) return state;
      return { ...state, results: { ...state.results, status: "error", error: action.message } };

    case "addToCart": {
      if (cartConflict(action.item.slug, state.cart.map((c) => c.slug))) return state;
      return { ...state, cart: [...state.cart, action.item], serverQuote: null, checkout: { status: "idle", error: null } };
    }

    case "removeFromCart": {
      const cart = state.cart.filter((c) => c.id !== action.id);
      const step = cart.length === 0 && state.step !== "search" ? "results" : state.step;
      return { ...state, cart, step, serverQuote: null, checkout: { status: "idle", error: null } };
    }

    case "toggleAddon":
      return {
        ...state,
        serverQuote: null,
        cart: state.cart.map((c) =>
          c.id !== action.itemId
            ? c
            : {
                ...c,
                addonIds: c.addonIds.includes(action.addonId)
                  ? c.addonIds.filter((a) => a !== action.addonId)
                  : [...c.addonIds, action.addonId],
              },
        ),
      };

    case "updateGuest":
      return { ...state, guest: { ...state.guest, ...action.patch } };

    case "guestSubmitted":
      return { ...state, guestSubmitted: true };

    case "goToStep":
      if (!canEnter(action.step, state)) return state;
      return { ...state, step: action.step, checkout: { status: "idle", error: null } };

    case "checkoutStarted":
      return { ...state, checkout: { status: "submitting", error: null } };

    case "checkoutFailed": {
      const { error } = action;
      if (error.code === "terms_changed") {
        // The terms this page shows are out of date: the tick given to them no longer counts (a reload of the
        // new page lands on the guest step with the box clear). Never retried automatically.
        return { ...state, guest: { ...state.guest, agreedToPolicy: false }, checkout: { status: "error", error } };
      }
      if (error.code === "price_changed" && action.quote) {
        const key = pricingKey(state);
        const serverQuote = key && isQuoteForCart(action.quote, state) ? { key, quote: action.quote } : state.serverQuote;
        return { ...state, serverQuote, checkout: { status: "error", error } };
      }
      if (error.code === "unavailable" && error.unavailableSlugs && error.unavailableSlugs.length > 0) {
        // The server is authoritative: drop those rooms now (a cached or
        // differently-sized search may still list them). Sold rooms are not
        // offered again for these dates; rooms refused only for the party size
        // stay bookable with fewer guests. The guest picks again on the results step.
        const gone = error.unavailableSlugs;
        const forParty = new Set(error.occupancySlugs ?? []);
        const sold = gone.filter((slug) => !forParty.has(slug));
        const dk = datesKey(state.search);
        const prev = state.refused?.datesKey === dk ? state.refused : null;
        const occupancy: Record<string, number> = { ...(prev?.occupancy ?? {}) };
        for (const item of state.cart) {
          if (!forParty.has(item.slug)) continue;
          occupancy[item.slug] = Math.min(occupancy[item.slug] ?? Infinity, item.adults);
        }
        const cart = state.cart.filter((c) => !gone.includes(c.slug));
        const name = (slug: string) => getCatalogueRoom(slug)?.name ?? slug;
        const parts: string[] = [];
        if (sold.length === 1 && forParty.size === 0 && isRestrictionMessage(error.message)) {
          // Not sold: a Cloudbeds stay rule (minimum stay, closed to arrival...) - say which, so the guest can change dates.
          parts.push(`${error.message} It was removed from your reservation.`);
        } else if (sold.length > 0) {
          const one = sold.length === 1;
          parts.push(
            `Sorry - ${sold.map(name).join(", ")} ${one ? "is" : "are"} no longer available for your dates and ${one ? "was" : "were"} removed from your reservation.`,
          );
        }
        for (const slug of forParty) {
          const adults = state.cart.find((c) => c.slug === slug)?.adults;
          parts.push(
            `${name(slug)} can't be booked online for ${adults ?? "that many"} guests, so it was removed - add it again with fewer guests or message us.`,
          );
        }
        return {
          ...state,
          cart,
          serverQuote: null,
          refused: { datesKey: dk, slugs: [...new Set([...(prev?.slugs ?? []), ...sold])], occupancy },
          step: state.step === "search" ? "search" : "results",
          notice: { kind: "rooms-removed", message: `${parts.join(" ")} Nothing has been charged.` },
          checkout: { status: "idle", error: null },
        };
      }
      return { ...state, checkout: { status: "error", error } };
    }

    case "checkoutRedirecting":
      return { ...state, checkout: { status: "redirecting", error: null } };

    case "checkoutReset":
      return { ...state, checkout: { status: "idle", error: null } };

    case "setNotice":
      return { ...state, notice: action.notice };

    case "reset":
      return { ...initialBookingState(), hydrated: true };
  }
}

/* ------------------------------ selectors ----------------------------- */

/** Cart as API input (no client ids, no prices). */
export function cartInputs(cart: CartItem[]): CartItemInput[] {
  return cart.map(({ slug, ratePlanId, adults, addonIds }) => ({ slug, ratePlanId, adults, addonIds }));
}

/**
 * Identifies what a quote prices: dates, valid promo and the cart's room
 * inputs (order matters - quote.lines[i] is cart[i]). Null without data.
 */
export function pricingKey(state: Pick<BookingState, "results" | "cart">): string | null {
  const data = state.results.data;
  if (!data || state.cart.length === 0) return null;
  const promo = data.promo?.valid ? data.promo.code : "";
  return JSON.stringify([data.search.checkIn, data.search.checkOut, promo, cartInputs(state.cart)]);
}

function isQuoteForCart(quote: Quote, state: Pick<BookingState, "results" | "cart">): boolean {
  const data = state.results.data;
  return (
    data !== null &&
    quote.checkIn === data.search.checkIn &&
    quote.checkOut === data.search.checkOut &&
    quote.lines.length === state.cart.length &&
    quote.lines.every(
      (l, i) => l.slug === state.cart[i].slug && l.ratePlanId === state.cart[i].ratePlanId && l.adults === state.cart[i].adults,
    )
  );
}

/**
 * The quote the guest sees and pays: the server's quote after a
 * price_changed answer for exactly this cart, otherwise the client-side quote
 * mirroring the server. quote.lines[i] corresponds to cart[i]. Null when
 * there is no data or the cart is empty.
 */
export function selectQuote(
  state: Pick<BookingState, "results" | "cart"> & Partial<Pick<BookingState, "serverQuote">>,
): Quote | null {
  const data = state.results.data;
  if (!data || state.cart.length === 0) return null;
  const server = state.serverQuote;
  if (server && server.key === pricingKey(state)) return server.quote;
  try {
    return computeQuote(
      {
        checkIn: data.search.checkIn,
        checkOut: data.search.checkOut,
        items: cartInputs(state.cart),
        promo: data.promo && data.promo.valid ? { code: data.promo.code, pct: data.promo.pct, label: data.promo.label } : null,
        pricing: { cardFeePct: data.config.cardFeePct, depositPct: data.config.depositPct },
      },
      data.offers,
    );
  } catch (e) {
    if (e instanceof QuoteError) return null;
    throw e;
  }
}

type RefusalState = Pick<BookingState, "cart"> & Partial<Pick<BookingState, "refused" | "search">>;

function refusalsForSearch(state: RefusalState): RefusedRooms | null {
  const refused = state.refused;
  return refused && state.search && refused.datesKey === datesKey(state.search) ? refused : null;
}

/**
 * Most guests that can be added for a room right now: the offer's limit (the
 * site's figure capped by Cloudbeds' maxGuests) and one fewer than a party
 * size the checkout just refused for these dates. 0 = can't be booked online.
 */
export function selectMaxAdults(state: RefusalState, slug: string, offerMax?: number): number {
  const base = offerMax ?? getCatalogueRoom(slug)?.maxGuests ?? 1;
  const refusedAt = refusalsForSearch(state)?.occupancy?.[slug];
  return refusedAt === undefined ? base : Math.min(base, refusedAt - 1);
}

/** Why a room can't be added right now, or null. */
export function selectBlockedReason(state: RefusalState, slug: string, adults?: number): string | null {
  const refused = refusalsForSearch(state);
  if (refused?.slugs.includes(slug)) return "No longer available for these dates.";
  const refusedAt = refused?.occupancy?.[slug];
  if (refusedAt !== undefined && (refusedAt <= 1 || (adults !== undefined && adults >= refusedAt))) {
    return refusedAt <= 1 ? "Can't be booked online for these dates - message us." : `Can't be booked online for ${refusedAt} or more guests.`;
  }
  return cartConflict(slug, state.cart.map((c) => c.slug))?.message ?? null;
}

export function newCartItemId(): string {
  return `ci_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function toCheckoutErrorView(e: ApiError & { quote?: Quote; unavailableSlugs?: string[]; occupancySlugs?: string[] }): CheckoutErrorView {
  return {
    code: e.error,
    message: e.message,
    newTotalSatang: e.quote?.totalSatang,
    newDueNowSatang: e.quote?.dueNowSatang,
    unavailableSlugs: e.unavailableSlugs,
    occupancySlugs: e.occupancySlugs,
    issues: e.issues,
    fixStep: e.fixStep,
    retryAfterMinutes: e.retryAfterMinutes,
  };
}

/* ----------------------------- persistence ---------------------------- */

export const STORAGE_KEY = "msv_booking_preview_v1";
/** Mirrors MAX_SEARCH_ADULTS / MAX_CART_ITEMS in lib/booking/config (server-only module). */
const MAX_PERSISTED_ADULTS = 18;
const MAX_PERSISTED_CART = 6;

export function toPersisted(state: BookingState): PersistedBooking {
  return {
    v: 1,
    step: state.step,
    search: state.search,
    cart: state.cart,
    cartKey: state.cartKey,
    guest: state.guest,
    landingKey: state.landingKey,
    termsVersion: POLICY_VERSION,
    savedAt: new Date().toISOString(),
  };
}

export function isStep(v: unknown): v is Step {
  return typeof v === "string" && (STEP_ORDER as string[]).includes(v);
}

function asObject(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function sanitizeCartItem(raw: unknown): CartItem | null {
  const r = asObject(raw);
  if (!r || typeof r.id !== "string" || r.id.length === 0 || r.id.length > 64) return null;
  if (typeof r.slug !== "string" || !isBookableSlug(r.slug) || !isRatePlanId(r.ratePlanId)) return null;
  const room = getCatalogueRoom(r.slug);
  const adults = r.adults;
  if (!room || typeof adults !== "number" || !Number.isInteger(adults) || adults < 1 || adults > room.maxGuests) return null;
  if (!Array.isArray(r.addonIds) || !r.addonIds.every(isAddonId)) return null;
  // Add-ons only on the rate plans that allow them (e.g. not breakfast-pp on the Breakfast plan).
  const ratePlanId = r.ratePlanId;
  if (!(r.addonIds as AddonId[]).every((a) => ADDONS[a].ratePlans.includes(ratePlanId))) return null;
  return { id: r.id, slug: r.slug, ratePlanId: r.ratePlanId, adults, addonIds: [...new Set(r.addonIds as AddonId[])] };
}

/** `termsCurrent`: the consent was given to the terms this page shows (else the box must be ticked again). */
function sanitizeGuest(raw: unknown, termsCurrent: boolean): GuestDetails {
  const r = asObject(raw) ?? {};
  const out: GuestDetails = { ...EMPTY_GUEST };
  for (const key of Object.keys(EMPTY_GUEST) as (keyof GuestDetails)[]) {
    const v = r[key];
    if (key === "agreedToPolicy") out.agreedToPolicy = termsCurrent && v === true;
    else if (typeof v === "string") out[key] = v.slice(0, 1000);
  }
  return out;
}

/**
 * Validates a saved booking deeply. sessionStorage may hold an older schema
 * or anything else, and a bad cart item would otherwise crash pricing during
 * render. One invalid item drops the whole cart (nothing is half-priced);
 * scalars are coerced to safe values.
 */
export function sanitizePersisted(v: unknown): PersistedBooking | null {
  const p = asObject(v);
  if (!p || p.v !== 1) return null;
  const search = asObject(p.search);
  if (!search) return null;
  const checkIn = typeof search.checkIn === "string" && isIsoDate(search.checkIn) ? search.checkIn : null;
  const checkOut = typeof search.checkOut === "string" && isIsoDate(search.checkOut) ? search.checkOut : null;
  const adultsRaw = search.adults;
  const adults =
    typeof adultsRaw === "number" && Number.isInteger(adultsRaw) && adultsRaw >= 1 && adultsRaw <= MAX_PERSISTED_ADULTS
      ? adultsRaw
      : DEFAULT_ADULTS;
  const promo = typeof search.promo === "string" ? search.promo.slice(0, 32) : "";

  const items = (Array.isArray(p.cart) ? p.cart : []).map(sanitizeCartItem);
  const valid = items.filter((i): i is CartItem => i !== null);
  // Mirror what the checkout API enforces, so a stale or edited cart can't
  // reach Pay only to fail: unique ids, no two rooms sharing a physical unit.
  const cartOk =
    items.length <= MAX_PERSISTED_CART &&
    valid.length === items.length &&
    new Set(valid.map((i) => i.id)).size === valid.length &&
    !hasUnitConflict(valid.map((i) => i.slug));
  const cart = cartOk ? valid : [];
  const landingKey = typeof p.landingKey === "string" && /^[a-f0-9]{8,64}$/.test(p.landingKey) ? p.landingKey : null;
  return {
    v: 1,
    step: isStep(p.step) ? p.step : "search",
    search: { checkIn, checkOut, adults, promo },
    cart,
    cartKey: cartOk && typeof p.cartKey === "string" ? p.cartKey : null,
    // A reload into a build with other terms (or a save from before the version was kept) asks for the tick again.
    guest: sanitizeGuest(p.guest, p.termsVersion === POLICY_VERSION),
    landingKey,
    ...(p.termsVersion === POLICY_VERSION ? { termsVersion: POLICY_VERSION } : {}),
    savedAt: typeof p.savedAt === "string" ? p.savedAt : "",
  };
}

/** Reads the saved booking (sessionStorage, this tab only). Safe on the server (returns null). */
export function readPersistedBooking(): PersistedBooking | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return sanitizePersisted(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

export function writePersistedBooking(state: BookingState): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(toPersisted(state)));
  } catch {
    // storage full or blocked: the flow still works, it just won't survive a reload
  }
}

/** After a successful payment: drop the cart so it can't be paid twice; keep the guest's name for display. */
export function clearPersistedCart(): void {
  const p = readPersistedBooking();
  if (!p) return;
  try {
    // Policy consent is per booking: a new reservation must tick the box again.
    const guest = { ...p.guest, agreedToPolicy: false };
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ ...p, guest, cart: [], cartKey: null, step: "search" }));
  } catch {
    // ignore
  }
}

/* ------------------------------- context ------------------------------ */

export interface AddRoomInput {
  slug: string;
  ratePlanId: RatePlanId;
  adults: number;
}

export interface BookingActions {
  /** Merge into the search draft (no request). */
  setSearch(patch: Partial<SearchDraft>): void;
  /** Run an availability search for the current draft (optionally patched first). */
  search(patch?: Partial<SearchDraft>): void;
  addRoom(input: AddRoomInput): void;
  removeRoom(itemId: string): void;
  toggleAddon(itemId: string, addonId: AddonId): void;
  updateGuest(patch: Partial<GuestDetails>): void;
  goToStep(step: Step): void;
  /** Step back (search <- results <- addons <- guest <- payment). */
  back(): void;
  /** Primary CTA for the current step (Book Now / Continue / Pay). */
  continue(): void;
  /** Guest form submit handler: validates, then moves to payment. */
  submitGuest(): void;
  /** POST /api/booking/checkout then top-level redirect to Beam / the demo page. */
  pay(): Promise<void>;
  dismissNotice(): void;
  openSecurePaymentInfo(): void;
}

export interface BookingContextValue {
  state: BookingState;
  dispatch: Dispatch<BookingAction>;
  actions: BookingActions;
  config: PublicBookingConfig;
  theme: ThemeName;
  quote: Quote | null;
  availability: AvailabilityResponse | null;
  analytics: BookingAnalytics;
  today: IsoDate;
}

export const BookingContext = createContext<BookingContextValue | null>(null);

export function useBooking(): BookingContextValue {
  const ctx = useContext(BookingContext);
  if (!ctx) throw new Error("useBooking must be used inside <BookingApp>");
  return ctx;
}
