// GA4 ecommerce events for the booking preview, shaped like the Cloudbeds
// engine's events so reports and the Google Ads purchase import line up.
//
// GATED: events reach window.dataLayer/gtag ONLY when paymentMode is
// "beam-live" AND NEXT_PUBLIC_VERCEL_ENV is "production". Everywhere else
// (demo, playground, previews, localhost) they go to window.__bookingEvents
// and console.debug, so nothing reaches GA4 or Google Ads.
// Payloads never contain personal data (no name, email or phone).

import { RATE_PLANS, getCatalogueRoom } from "./catalogue.ts";
import { averageNightlySatang, satangToBaht } from "./quote.ts";
import { track } from "../track.ts";
import type { BookingSummary, IsoDate, PaymentMode, Quote, QuoteLine, RatePlanId } from "./types.ts";

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
  return paymentMode === "beam-live" && vercelEnv === "production";
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
  return {
    item_id: room?.cloudbedsRoomTypeId ?? src.slug,
    item_name: room?.name ?? src.slug,
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
  /** Fires once per booking ref (sessionStorage guard). Call only after a verified "paid" status. */
  purchase(booking: BookingSummary): void;
}

function emit(enabled: boolean, name: string, params: Record<string, unknown>): void {
  if (typeof window === "undefined") return;
  const payload = { currency: "THB", be_source: BE_SOURCE, ...params };
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

function purchaseAlreadySent(ref: string): boolean {
  try {
    if (sessionStorage.getItem(PURCHASE_GUARD_PREFIX + ref)) return true;
    sessionStorage.setItem(PURCHASE_GUARD_PREFIX + ref, "1");
    return false;
  } catch {
    return false;
  }
}

export function createBookingAnalytics(paymentMode: PaymentMode): BookingAnalytics {
  const enabled = analyticsEnabled(paymentMode);
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
        coupon: quote.promo?.code ?? "",
        start_date: quote.checkIn,
        end_date: quote.checkOut,
        items: quote.lines.map((l) => itemFromQuoteLine(l, quote)),
      });
    },
    addPaymentInfo(quote) {
      emit(enabled, "add_payment_info", {
        value: satangToBaht(quote.totalSatang),
        payment_type: "beam",
        coupon: quote.promo?.code ?? "",
        items: quote.lines.map((l) => itemFromQuoteLine(l, quote)),
      });
    },
    purchase(booking) {
      if (typeof window === "undefined" || purchaseAlreadySent(booking.ref)) return;
      emit(enabled, "purchase", {
        transaction_id: booking.ref,
        value: satangToBaht(booking.dueNowSatang),
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
      });
    },
  };
}
