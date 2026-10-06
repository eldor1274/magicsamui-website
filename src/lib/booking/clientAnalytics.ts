// GA4 ecommerce events for the booking preview, shaped like the Cloudbeds
// engine's events so reports and the Google Ads purchase import line up.
//
// GATED: events reach window.dataLayer/gtag ONLY when paymentMode is a live
// mode ("stripe-live" or "beam-live") AND NEXT_PUBLIC_VERCEL_ENV is
// "production". Everywhere else (demo, mock, test, previews, localhost) they
// go to window.__bookingEvents and console.debug, so nothing reaches GA4 or
// Google Ads.
//
// purchase (WI-10): fired once, only after the SERVER reported the booking
// paid AND confirmed in Cloudbeds. In stripe-live the server says so by
// returning StatusResponse.purchase (only then); transaction_id is the
// Cloudbeds reservationID (the same id the Cloudbeds engine reports, so GA4
// and the Google Ads import de-duplicate) and value is in baht.
// Payloads never contain personal data (no name, email or phone).
// Like Cloudbeds, every event carries property_id and item_name is the
// Cloudbeds room type name (not the site's marketing name).

import { CLOUDBEDS_PROPERTY_ID, CLOUDBEDS_ROOM_NAMES } from "../../data/cloudbeds.ts";
import { RATE_PLANS, getCatalogueRoom } from "./catalogue.ts";
import { averageNightlySatang, satangToBaht } from "./quote.ts";
import { analyticsPaymentType } from "./payments/provider.ts";
import { track } from "../track.ts";
import type { BookingSummary, IsoDate, PaymentMode, PurchaseView, Quote, QuoteLine, RatePlanId } from "./types.ts";

export const AFFILIATION = "Magic Suites & Villas";
export const BE_SOURCE = "magicsamui-direct";
const PURCHASE_GUARD_PREFIX = "msv_booking_purchase_sent_";

export interface AnalyticsItem {
  item_id: string;
  item_name: string;
  item_category: "accommodation";
  item_package_id: string;
  item_package_name: string;
  /** Per-night rate in baht. */
  price: number;
  /** Number of nights. */
  quantity: number;
  start_date: IsoDate;
  end_date: IsoDate;
  nights: number;
  adults: number;
  kids: 0;
  total_guests: number;
  affiliation: string;
}

export interface RecordedBookingEvent {
  name: string;
  params: Record<string, unknown>;
  sent: boolean;
  at: string;
}

type BookingEventWindow = Window & { __bookingEvents?: RecordedBookingEvent[] };

export function analyticsEnabled(paymentMode: PaymentMode, vercelEnv: string | undefined = process.env.NEXT_PUBLIC_VERCEL_ENV): boolean {
  return (paymentMode === "beam-live" || paymentMode === "stripe-live") && vercelEnv === "production";
}

export interface ItemSource {
  slug: string;
  ratePlanId: RatePlanId;
  adults: number;
  nights: number;
  /** Room total for the stay (satang). */
  roomSatang: number;
  checkIn: IsoDate;
  checkOut: IsoDate;
}

export function buildAnalyticsItem(src: ItemSource): AnalyticsItem {
  const room = getCatalogueRoom(src.slug);
  const plan = RATE_PLANS[src.ratePlanId];
  const perNight = src.nights > 0 ? Math.round(src.roomSatang / src.nights) : 0;
  const itemId = room?.cloudbedsRoomTypeId ?? src.slug;
  return {
    item_id: itemId,
    item_name: CLOUDBEDS_ROOM_NAMES[itemId] ?? room?.name ?? src.slug,
    item_category: "accommodation",
    item_package_id: plan.packageId,
    item_package_name: plan.name,
    price: satangToBaht(perNight),
    quantity: src.nights,
    start_date: src.checkIn,
    end_date: src.checkOut,
    nights: src.nights,
    adults: src.adults,
    kids: 0,
    total_guests: src.adults,
    affiliation: AFFILIATION,
  };
}

export function itemFromQuoteLine(line: QuoteLine, quote: Pick<Quote, "checkIn" | "checkOut">): AnalyticsItem {
  const item = buildAnalyticsItem({
    slug: line.slug,
    ratePlanId: line.ratePlanId,
    adults: line.adults,
    nights: line.nights,
    roomSatang: line.roomSatang,
    checkIn: quote.checkIn,
    checkOut: quote.checkOut,
  });
  return { ...item, price: satangToBaht(averageNightlySatang(line)) };
}

export interface BookingAnalytics {
  readonly enabled: boolean;
  addToCart(line: QuoteLine, quote: Pick<Quote, "checkIn" | "checkOut">): void;
  removeFromCart(line: QuoteLine, quote: Pick<Quote, "checkIn" | "checkOut">): void;
  beginCheckout(quote: Quote): void;
  addPaymentInfo(quote: Quote): void;
  /**
   * Fires once per booking (sessionStorage guard). Call only after a verified
   * "paid" status. Stripe modes: pass StatusResponse.purchase - without it
   * (not confirmed in Cloudbeds yet, or not live) nothing is sent.
   */
  purchase(booking: BookingSummary, confirmed?: PurchaseView | null): void;
  /** The "Having trouble paying?" rescue strip appeared (same gate as everything else). */
  helpShown(): void;
  /** A rescue channel was used from the strip. */
  helpClick(channel: "whatsapp" | "call"): void;
}

/** Common fields of every event (Cloudbeds sends property_id on each one). */
export function basePayload(params: Record<string, unknown>): Record<string, unknown> {
  return { currency: "THB", be_source: BE_SOURCE, property_id: CLOUDBEDS_PROPERTY_ID, ...params };
}

/**
 * Sends (enabled) or only records (disabled) one event. Exported for tests;
 * the booking flow uses createBookingAnalytics().
 */
export function emit(enabled: boolean, name: string, params: Record<string, unknown>): void {
  if (typeof window === "undefined") return;
  const payload = basePayload(params);
  try {
    if (enabled) {
      track(name, payload);
    } else {
      const w = window as BookingEventWindow;
      w.__bookingEvents = w.__bookingEvents ?? [];
      w.__bookingEvents.push({ name, params: payload, sent: false, at: new Date().toISOString() });
      console.debug(`[booking-preview analytics - not sent] ${name}`, payload);
    }
  } catch {
    // analytics must never break the booking flow
  }
}

/** Refs whose purchase this page already queued (re-renders and polls must not queue it twice). */
const purchaseQueued = new Set<string>();

function purchaseAlreadySent(ref: string): boolean {
  if (purchaseQueued.has(ref)) return true;
  try {
    return sessionStorage.getItem(PURCHASE_GUARD_PREFIX + ref) !== null;
  } catch {
    return false;
  }
}

function markPurchaseSent(ref: string): void {
  try {
    sessionStorage.setItem(PURCHASE_GUARD_PREFIX + ref, "1");
  } catch {
    // storage blocked: the in-page guard still holds for this load
  }
}

/** GA4 `coupon`: the demo's discount code, or the guest's code when rooms are on Cloudbeds' Direct rate ("" = none). */
export function couponOf(quote: Pick<Quote, "promo" | "directRate">): string {
  return quote.promo?.code ?? quote.directRate?.code ?? "";
}

/** Purchase item list and totals in the Cloudbeds shape (subtotal = value before the card fee). */
export function purchaseParams(booking: BookingSummary, confirmed: PurchaseView | null = null): Record<string, unknown> {
  return {
    transaction_id: confirmed?.transactionId ?? booking.ref,
    value: confirmed?.valueBaht ?? satangToBaht(booking.dueNowSatang),
    subtotal: satangToBaht(booking.totalSatang - booking.cardFeeSatang),
    tax: satangToBaht(booking.cardFeeSatang),
    coupon: booking.promoCode ?? "",
    affiliation: AFFILIATION,
    start_date: booking.checkIn,
    end_date: booking.checkOut,
    nights: booking.nights,
    items: booking.items.map((it, i) =>
      buildAnalyticsItem({
        slug: it.slug,
        ratePlanId: it.ratePlanId,
        adults: it.adults,
        nights: booking.nights,
        roomSatang: booking.itemRoomSatang[i] ?? 0,
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
      }),
    ),
  };
}

/** `vercelEnv` is injectable for tests; the app uses NEXT_PUBLIC_VERCEL_ENV. */
export function createBookingAnalytics(paymentMode: PaymentMode, vercelEnv?: string): BookingAnalytics {
  const enabled = vercelEnv === undefined ? analyticsEnabled(paymentMode) : analyticsEnabled(paymentMode, vercelEnv);
  return {
    enabled,
    addToCart(line, quote) {
      emit(enabled, "add_to_cart", { value: satangToBaht(line.roomSatang), items: [itemFromQuoteLine(line, quote)] });
    },
    removeFromCart(line, quote) {
      emit(enabled, "remove_from_cart", { value: satangToBaht(line.roomSatang), items: [itemFromQuoteLine(line, quote)] });
    },
    beginCheckout(quote) {
      emit(enabled, "begin_checkout", {
        value: satangToBaht(quote.totalSatang),
        subtotal: satangToBaht(quote.totalSatang - quote.cardFeeSatang),
        coupon: couponOf(quote),
        start_date: quote.checkIn,
        end_date: quote.checkOut,
        items: quote.lines.map((l) => itemFromQuoteLine(l, quote)),
      });
    },
    addPaymentInfo(quote) {
      emit(enabled, "add_payment_info", {
        value: satangToBaht(quote.totalSatang),
        payment_type: analyticsPaymentType(paymentMode),
        coupon: couponOf(quote),
        items: quote.lines.map((l) => itemFromQuoteLine(l, quote)),
      });
    },
    helpShown() {
      emit(enabled, "booking_help_shown", {});
    },
    helpClick(channel) {
      emit(enabled, "booking_help_click", { channel });
    },
    purchase(booking, confirmed = null) {
      // Stripe: no purchase until the server confirms the Cloudbeds reservation (it then supplies the reservationID).
      if (booking.paymentMode.startsWith("stripe-") && !confirmed) return;
      if (typeof window === "undefined" || purchaseAlreadySent(booking.ref)) return;
      purchaseQueued.add(booking.ref);
      const ref = booking.ref;
      if (!enabled) {
        emit(false, "purchase", purchaseParams(booking, confirmed));
        markPurchaseSent(ref);
        return;
      }
      // gtag.js loads late (after an interaction, or 4 s): the tab-wide guard
      // is set only once gtag has actually sent the event (event_callback), so
      // a guest who leaves before that gets it re-sent on a reload in this
      // tab. GA4 and the Ads import de-duplicate on transaction_id.
      emit(true, "purchase", { ...purchaseParams(booking, confirmed), event_callback: () => markPurchaseSent(ref) });
    },
  };
}
