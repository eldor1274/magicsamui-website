// OWNER: foundation. Booking flow state: reducer, selectors, persistence and
// the React context. UI components read it with useBooking() or receive
// props from BookingApp. Change the contract only through the foundation.

import { createContext, useContext } from "react";
import type { Dispatch } from "react";
import { cartConflict } from "@/lib/booking/catalogue";
import type { BookingAnalytics } from "@/lib/booking/clientAnalytics";
import { isIsoDate } from "@/lib/booking/dates";
import { EMPTY_GUEST } from "@/lib/booking/guest";
import type { GuestDetails } from "@/lib/booking/guest";
import { QuoteError, computeQuote } from "@/lib/booking/quote";
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
  /** For unavailable: rooms that were just sold. */
  unavailableSlugs?: string[];
}

export interface CheckoutState {
  status: "idle" | "submitting" | "redirecting" | "error";
  error: CheckoutErrorView | null;
}

export type NoticeKind = "payment-cancelled" | "cart-cleared" | "rooms-removed" | "info";

export interface Notice {
  kind: NoticeKind;
  message: string;
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
  savedAt: string;
}

export type BookingAction =
  | {
      type: "hydrate";
      persisted: PersistedBooking | null;
      /** Valid ?checkin/?checkout/?adults/?promo from the URL (wins over persisted search). */
      initialSearch: Partial<SearchDraft> | null;
      /** "payment" when Beam's cancel button sent the guest back. */
      resume: "payment" | null;
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
  | { type: "checkoutFailed"; error: CheckoutErrorView }
  | { type: "checkoutRedirecting" }
  | { type: "setNotice"; notice: Notice | null }
  | { type: "reset" };

/* ------------------------------ reducer ------------------------------ */

function canEnter(step: Step, state: BookingState): boolean {
  switch (step) {
    case "search":
      return true;
    case "results":
      return state.search.checkIn !== null && state.search.checkOut !== null;
    case "addons":
    case "guest":
    case "payment":
      return state.cart.length > 0;
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

      if (action.initialSearch) {
        const next = { ...search, ...action.initialSearch };
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
      if (action.resume === "payment" && cart.length > 0) {
        step = "payment";
        notice = { kind: "payment-cancelled", message: "Payment cancelled - nothing was charged. Your reservation is still here." };
      }
      if (step !== "search" && step !== "results" && cart.length === 0) step = search.checkIn && search.checkOut ? "results" : "search";
      if (step === "results" && !(search.checkIn && search.checkOut)) step = "search";
      return { ...base, step, search, cart, cartKey, guest: usable?.guest ?? base.guest, notice, hydrated: true };
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
      const step = stillOk.length === 0 && state.step !== "search" && state.step !== "results" ? "results" : state.step;
      return {
        ...state,
        step,
        cart: stillOk,
        cartKey: dk,
        notice,
        results: { status: "ready", data, error: null, requestKey: action.key },
      };
    }

    case "searchFailed":
      if (action.key !== state.results.requestKey) return state;
      return { ...state, results: { ...state.results, status: "error", error: action.message } };

    case "addToCart": {
      if (cartConflict(action.item.slug, state.cart.map((c) => c.slug))) return state;
      return { ...state, cart: [...state.cart, action.item], checkout: { status: "idle", error: null } };
    }

    case "removeFromCart": {
      const cart = state.cart.filter((c) => c.id !== action.id);
      const step = cart.length === 0 && state.step !== "search" ? "results" : state.step;
      return { ...state, cart, step, checkout: { status: "idle", error: null } };
    }

    case "toggleAddon":
      return {
        ...state,
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

    case "checkoutFailed":
      return { ...state, checkout: { status: "error", error: action.error } };

    case "checkoutRedirecting":
      return { ...state, checkout: { status: "redirecting", error: null } };

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
 * Client-side quote mirroring the server. quote.lines[i] corresponds to
 * cart[i]. Null when there is no data or the cart is empty.
 */
export function selectQuote(state: Pick<BookingState, "results" | "cart">): Quote | null {
  const data = state.results.data;
  if (!data || state.cart.length === 0) return null;
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

/** Why a room can't be added right now, or null. */
export function selectBlockedReason(state: Pick<BookingState, "cart">, slug: string): string | null {
  return cartConflict(slug, state.cart.map((c) => c.slug))?.message ?? null;
}

export function newCartItemId(): string {
  return `ci_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function toCheckoutErrorView(e: ApiError & { quote?: Quote; unavailableSlugs?: string[] }): CheckoutErrorView {
  return {
    code: e.error,
    message: e.message,
    newTotalSatang: e.quote?.totalSatang,
    unavailableSlugs: e.unavailableSlugs,
  };
}

/* ----------------------------- persistence ---------------------------- */

export const STORAGE_KEY = "msv_booking_preview_v1";

export function toPersisted(state: BookingState): PersistedBooking {
  return {
    v: 1,
    step: state.step,
    search: state.search,
    cart: state.cart,
    cartKey: state.cartKey,
    guest: state.guest,
    savedAt: new Date().toISOString(),
  };
}

function isPersisted(v: unknown): v is PersistedBooking {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Partial<PersistedBooking>;
  return (
    p.v === 1 &&
    typeof p.step === "string" &&
    typeof p.search === "object" &&
    p.search !== null &&
    (p.search.checkIn === null || isIsoDate(p.search.checkIn)) &&
    (p.search.checkOut === null || isIsoDate(p.search.checkOut)) &&
    Array.isArray(p.cart) &&
    typeof p.guest === "object"
  );
}

/** Reads the saved booking (sessionStorage, this tab only). Safe on the server (returns null). */
export function readPersistedBooking(): PersistedBooking | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isPersisted(parsed) ? { ...parsed, guest: { ...EMPTY_GUEST, ...parsed.guest } } : null;
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
