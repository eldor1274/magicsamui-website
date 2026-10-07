// Shared types for the own-booking-engine preview (/booking-preview).
//
// Rules that keep this folder runnable under `node --test` (Node 24 strips
// types natively): relative imports with explicit ".ts" extensions, `import
// type` for type-only imports, and erasable TypeScript only (no enums,
// namespaces or parameter properties).
//
// Money is ALWAYS integer satang (1 THB = 100 satang) and named *Satang.
// Dates are ISO calendar dates "YYYY-MM-DD" in Asia/Bangkok (property-local).

import type { GuestDetails } from "./guest.ts";

export type IsoDate = string;

/**
 * Payment provider chosen by BOOKING_PAYMENT_PROVIDER (stripe | beam | demo).
 * Unset keeps the legacy rule: beam when BEAM_API_BASE is set, else demo.
 */
export type PaymentProvider = "demo" | "beam" | "stripe";

/**
 * Concrete payment mode (provider + test/live):
 * - demo: simulated payment, nothing leaves our servers.
 * - beam-playground / beam-live: Beam payment links (beam-live is locked in code: no fulfilment).
 * - stripe-mock: in-repo fake Stripe + fake Cloudbeds (local click-through, clearly labelled MOCK).
 * - stripe-test: Stripe test keys (sk_test_/rk_test_). Cloudbeds writes are REAL when
 *   CLOUDBEDS_API_KEY_BOOKING is set (guarded), otherwise mocked.
 * - stripe-live: live keys + every live condition (see config.ts stripeLiveBlockers).
 */
export type PaymentMode = "demo" | "beam-playground" | "beam-live" | "stripe-mock" | "stripe-test" | "stripe-live";

/** Where availability and nightly rates came from for a response. */
export type DataSource = "demo" | "cloudbeds" | "demo-fallback";

/** Physical inventory units. A room type is a combination of one or more. */
export type UnitId = "HM" | "SR" | "GS" | "SVL" | "TUX" | "TUXL";

export type RatePlanId = "standard" | "breakfast";

export type AddonId = "breakfast-pp";

export type ThemeName = "magic" | "classic";

export interface RoomPhoto {
  src: string;
  alt: string;
}

/** Static, isomorphic room content (safe to import on the client). */
export interface CatalogueRoom {
  slug: string;
  name: string;
  shortName: string;
  /** Cloudbeds roomTypeID, or null when the room type is not sold online. */
  cloudbedsRoomTypeId: string | null;
  bookable: boolean;
  units: UnitId[];
  maxGuests: number;
  bedrooms: number;
  bathrooms: number;
  areaSqm: number;
  hasPool: boolean;
  poolType: string | null;
  summary: string;
  description: string[];
  amenities: string[];
  heroImage: RoomPhoto;
  gallery: RoomPhoto[];
  /** Reference price from rooms.ts. Demo pricing input only - never charged directly. */
  referencePriceThb: number;
}

export interface PolicySection {
  heading: string;
  body: string;
}

export interface RatePlanInfo {
  id: RatePlanId;
  name: string;
  /** Extra per guest per night on top of the room rate (0 for standard). */
  supplementSatangPerGuestPerNight: number;
  /** Cloudbeds package id used in analytics (item_package_id). */
  packageId: string;
  shortDescription: string;
  image: RoomPhoto | null;
  policy: PolicySection[];
}

export interface AddonInfo {
  id: AddonId;
  name: string;
  description: string;
  chargeType: "per-guest-per-night";
  priceSatangPerGuestPerNight: number;
  /** Night weekdays the add-on can be served, 0 = Sunday ... 6 = Saturday. */
  availableWeekdays: number[];
  image: RoomPhoto | null;
  /** Rate plans an add-on can be attached to. */
  ratePlans: RatePlanId[];
}

export interface NightRate {
  /** The night starting on this date. */
  date: IsoDate;
  amountSatang: number;
}

/** One sellable rate plan for a room type, priced for the stay. */
export interface RateOffer {
  ratePlanId: RatePlanId;
  ratePlanName: string;
  /** Room-only nightly rates (before plan supplement). */
  baseNightly: NightRate[];
  /** Plan supplement per guest per night (breakfast plan only). */
  supplementSatangPerGuestPerNight: number;
  /**
   * Occupancy pricing: extra charge for the WHOLE stay keyed by adult count
   * ("3" -> satang), from Cloudbeds adultsExtraCharge. Empty when the room
   * has no extra-adult charges (always empty for demo data).
   */
  adultsExtraSatang: Record<string, number>;
  /** Total for the stay at `pricedForAdults` guests (base + occupancy extra + supplement). */
  totalSatang: number;
  pricedForAdults: number;
  /**
   * Set when this is a discounted Cloudbeds rate - the Direct (promo code) rate or an automatic discount
   * plan: the base (BAR) rate it is derived from, shown struck through next to the discounted price.
   */
  list?: RateListPrice;
}

/** Which discounted Cloudbeds rate a room is sold on: the Direct rate for the guest's code, or an automatic discount plan. */
export type DiscountKind = "direct" | "auto";

/** RateOffer.list: the base rate a discounted rate is derived from. */
export interface RateListPrice {
  baseNightly: NightRate[];
  adultsExtraSatang: Record<string, number>;
  /** Absent in answers from before automatic discounts: the Direct rate. */
  kind?: DiscountKind;
  /**
   * auto: the plan's public name in Cloudbeds (e.g. "Last minute 10% off"), shown as the rate's label. direct: set only
   * for a promo code other than the DIRECT alias (e.g. LONGSTAY), whose plan's public name labels the rate
   * ("Long term - code LONGSTAY"); absent for DIRECT ("Direct rate - code DIRECT").
   */
  name?: string;
}

export type UnavailableReason = "sold-out" | "not-bookable";

export interface RoomOffer {
  slug: string;
  available: boolean;
  unavailableReason: UnavailableReason | null;
  /** Units left for the stay (0 or 1 - every room type is a single unit). */
  remaining: number;
  /** True when the room alone can host the searched number of guests. */
  fitsParty: boolean;
  /**
   * Most guests bookable online: min(site maxGuests, Cloudbeds maxGuests).
   * Absent in older answers - fall back to the catalogue's maxGuests.
   */
  maxAdults?: number;
  rates: RateOffer[];
  /**
   * The guest's Direct code was checked but Cloudbeds has no Direct rate for this room and these dates (or an
   * automatic discount is cheaper): the standard rate, or that discount, is shown.
   */
  promoNotApplied?: boolean;
}

export interface StaySearch {
  checkIn: IsoDate;
  checkOut: IsoDate;
  adults: number;
  promo?: string;
}

/**
 * pct is the demo's site-side discount; 0 for a Cloudbeds promo-code rate (the
 * rates themselves are lower). label: "Direct rate" for the DIRECT code, the
 * plan's public name for any other Cloudbeds promo code. An invalid result with
 * `note` is not an error: the code is real but can't be used here (shown calmly,
 * with `link` when set).
 */
export type PromoResult =
  | { code: string; valid: true; pct: number; label: string }
  | { code: string; valid: false; message: string; note?: true; link?: { href: string; text: string } };

/**
 * How a promo code works on this deployment (config.ts resolvePromoSettings):
 * - discount: demo only, a site-side % (BOOKING_DEMO_PROMO_PCT);
 * - direct-rate: Stripe with live Cloudbeds rates and BOOKING_DIRECT_PROMO on: Cloudbeds' own Direct rate plan is sold
 *   for DIRECT, and the plan of any other promo code the owner set up in Cloudbeds for that code (PromoLookup);
 * - classic-only: Stripe without it (flag off, or no Cloudbeds rates): every code is pointed to the classic booking page;
 * - off: Beam modes (no code applies).
 */
export type PromoMode = "discount" | "direct-rate" | "classic-only" | "off";

/**
 * What the rate-plan index (one getRatePlans read for the stay) says about a promo code other than the DIRECT alias
 * (cloudbedsProvider.ts promoIndexOf): whether a plan the own page may sell carries it (compared trimmed and
 * case-insensitively), and Cloudbeds' own spelling of it, which is what getAvailableRoomTypes and postReservation get.
 */
export interface PromoLookup {
  /** The code looked up, as the guest typed it (upper case). */
  code: string;
  /** Cloudbeds' own spelling of the code on the first sellable plan carrying it; null = no sellable plan carries it for these dates. */
  cloudbedsCode: string | null;
  /** That plan's public name (as the page shows it), the code's label; null when it has none. */
  planName: string | null;
  /** Public names of the plans carrying the code that the own page never sells (their names read as non-refundable). */
  refusedPlans: string[];
}

/** Pricing knobs the client needs to mirror the server quote. */
export interface PricingConfig {
  cardFeePct: number;
  depositPct: number;
}

export type CardBrand = "visa" | "mastercard" | "amex" | "jcb" | "unionpay";
export type PaymentMethodBadge = "card" | "promptpay" | "apple_pay" | "google_pay";

/** Non-secret config the browser may see. */
export interface PublicBookingConfig extends PricingConfig {
  paymentMode: PaymentMode;
  /** demo | beam | stripe (BOOKING_PAYMENT_PROVIDER). */
  provider: PaymentProvider;
  /** True only when real money can be charged (beam-live / stripe-live). */
  live: boolean;
  /** Provider test mode (beam-playground / stripe-test): test cards only. */
  testMode: boolean;
  /** stripe-mock: fake Stripe + fake Cloudbeds - label everything MOCK. */
  mock: boolean;
  /**
   * Where the reservation is written: "live" = a real Cloudbeds reservation (hold-first),
   * "mock" = simulated writer (nothing reaches Cloudbeds), "none" = no reservation (demo/beam preview).
   */
  cloudbedsWrites: "live" | "mock" | "none";
  /** True when the server needs the guest's details at checkout (stripe modes): send CheckoutRequest.guest. */
  requiresGuestDetails: boolean;
  /** Ask for a postcode (sent to Cloudbeds as guestZip; optional for the guest - a placeholder is sent when empty). */
  collectPostcode: boolean;
  /** Rate plans offered (stripe: Standard only - Cloudbeds does not price the synthetic Breakfast plan). */
  ratePlans: RatePlanId[];
  /** Add-ons offered (false in stripe modes). */
  addonsEnabled: boolean;
  /** Card brands the provider accepts (Stripe Thailand: Visa + Mastercard only). */
  acceptedCardBrands: CardBrand[];
  /** Payment method badges to show. */
  paymentMethods: PaymentMethodBadge[];
  /** How long the room is held while the guest pays (minutes). */
  holdMinutes: number;
  /**
   * Stripe modes: whether Cloudbeds emails the guest a booking confirmation
   * when we confirm (CLOUDBEDS_SEND_STATUS_EMAIL). When false the only email
   * is Stripe's payment receipt, and copy must not promise a confirmation email.
   */
  sendsBookingConfirmationEmail: boolean;
  /**
   * stripe-test with REAL Cloudbeds writes only: holds are refused unless the
   * arrival is at least `minArrivalMonths` ahead and the guest email is the
   * owner's test address (the address itself is never exposed). null otherwise.
   */
  testGuard: { minArrivalMonths: number } | null;
  /** Path of the own booking page for this deployment ("/booking" once BOOKING_ENGINE=own is active, else "/booking-preview"). */
  bookingPath: string;
  /** Where the Cloudbeds booking engine lives: the fallback offered when online payment here is paused ("/booking/classic" with BOOKING_ENGINE=own, else "/booking"). */
  classicBookingPath: string;
  /** WhatsApp fallback link (show it when payments are locked or a booking needs attention). */
  whatsappUrl: string;
  /** "locked" when live Beam credentials are configured without every live-mode condition. */
  paymentStatus: "ok" | "locked";
  dataSource: "demo" | "cloudbeds";
  merchantName: string;
  maxNights: number;
  bookingWindowMonths: number;
  maxSearchAdults: number;
  /** True when a promo code can change the price here (the demo discount, or the Cloudbeds Direct rate). */
  promoEnabled: boolean;
  /** How a code works here (see PromoMode). Absent in answers cached before it existed. */
  promoMode?: PromoMode;
  /** The code guests type (BOOKING_PROMO_CODE, default DIRECT): not a secret, the site advertises it. */
  promoCode?: string;
}

export interface CartItem {
  /** Client-side id, unique within the cart. */
  id: string;
  slug: string;
  ratePlanId: RatePlanId;
  adults: number;
  addonIds: AddonId[];
}

/** What the client sends to price or book a cart item (never prices). */
export interface CartItemInput {
  slug: string;
  ratePlanId: RatePlanId;
  adults: number;
  addonIds: AddonId[];
}

export interface QuoteAddonLine {
  addonId: AddonId;
  name: string;
  eligibleNights: IsoDate[];
  guests: number;
  amountSatang: number;
}

export interface QuoteLine {
  slug: string;
  roomName: string;
  ratePlanId: RatePlanId;
  ratePlanName: string;
  adults: number;
  nights: number;
  /** Per-night room price for this line incl. plan supplement. */
  nightly: NightRate[];
  /** Extra-adult (occupancy) charge for the stay, included in roomSatang. */
  occupancyExtraSatang: number;
  roomSatang: number;
  /** On a discounted Cloudbeds rate (Direct or automatic): the same room at the base rate (shown struck through). Absent otherwise. */
  listRoomSatang?: number;
  /**
   * With listRoomSatang: which discounted rate the line is on. name: the automatic discount plan's public name
   * (its label); for a promo-code rate "Direct rate" (DIRECT) or the plan's public name (any other code), labelled
   * "<name> - code <CODE>" (lineDiscountLabel). Absent in quotes from before automatic discounts (the Direct rate).
   */
  discount?: { kind: DiscountKind; name: string };
  addons: QuoteAddonLine[];
  addonsSatang: number;
}

export interface QuotePromo {
  code: string;
  pct: number;
  label: string;
  discountSatang: number;
}

/**
 * The guest's Cloudbeds promo-code rate on a quote - the Direct rate for DIRECT, or the plan of any other code (e.g.
 * LONGSTAY) - (its rooms are already priced at it: nothing is deducted again).
 */
export interface QuoteDirectRate {
  /** The code the guest entered (e.g. DIRECT, LONGSTAY). */
  code: string;
  /** "Direct rate - code DIRECT", or "<plan public name> - code <CODE>" for another code. */
  label: string;
  /** The rooms at the base rate (lines on the Direct rate at their list price, the others as quoted). */
  baseRoomsSatang: number;
  /** baseRoomsSatang - roomsSubtotalSatang. */
  savingSatang: number;
}

/** Cloudbeds' automatic discount plans on a quote (already in the room prices: nothing is deducted again). */
export interface QuoteAutoDiscount {
  /** The plans' public names, e.g. ["Long term booking"]. */
  names: string[];
  /** The rooms with the lines on an automatic discount at their base price, the others as quoted. */
  baseRoomsSatang: number;
  /** baseRoomsSatang - roomsSubtotalSatang. */
  savingSatang: number;
}

export interface Quote {
  currency: "THB";
  checkIn: IsoDate;
  checkOut: IsoDate;
  nights: number;
  lines: QuoteLine[];
  /** What Cloudbeds holds for the rooms (on the Direct rate or an automatic discount where it applies). */
  roomsSubtotalSatang: number;
  addonsSubtotalSatang: number;
  /** The demo's site-side discount (deducted below the rooms). */
  promo: QuotePromo | null;
  /** The Cloudbeds Direct rate (already in the room prices); absent or null when no line is on it. */
  directRate?: QuoteDirectRate | null;
  /** Cloudbeds' automatic discount plans (already in the room prices); absent or null when no line is on one. */
  autoDiscount?: QuoteAutoDiscount | null;
  /** rooms + addons - promo; the base the card fee is charged on. */
  feeBaseSatang: number;
  cardFeePct: number;
  cardFeeSatang: number;
  totalSatang: number;
  depositPct: number;
  dueNowSatang: number;
  balanceSatang: number;
}

/* ------------------------------------------------------------------ */
/* API contracts                                                       */
/* ------------------------------------------------------------------ */

export interface ApiError {
  ok: false;
  error: BookingErrorCode;
  message: string;
  /** Field-level problems for invalid_request (guest-facing sentences). */
  issues?: string[];
  /** invalid_request: the step where the guest can fix it ("addons" = an add-on no longer fits the stay). */
  fixStep?: "addons";
  /** rate_limited: roughly how long the guest should wait before trying again. */
  retryAfterMinutes?: number;
}

export type BookingErrorCode =
  | "invalid_request"
  | "unavailable"
  | "price_changed"
  | "promo_invalid"
  | "payment_unavailable"
  | "live_payments_locked"
  | "invalid_token"
  | "not_found"
  | "rate_limited"
  | "upstream_error"
  | "server_error"
  /** stripe-test with real Cloudbeds writes: arrival too soon or not the owner's test email. */
  | "test_mode_restricted"
  /** Stripe modes: the booking terms changed since the guest's page loaded (refresh, review and tick again). */
  | "terms_changed"
  /** Client-side only: the request never got a response. */
  | "network_error";

/** GET /api/booking/availability?checkin&checkout&adults[&promo] */
export interface AvailabilityResponse {
  ok: true;
  search: StaySearch;
  nights: number;
  dataSource: DataSource;
  config: PublicBookingConfig;
  promo: PromoResult | null;
  offers: RoomOffer[];
  generatedAt: string;
}

/** POST /api/booking/checkout */
export interface CheckoutRequest {
  checkIn: IsoDate;
  checkOut: IsoDate;
  promo?: string;
  items: CartItemInput[];
  /**
   * The total the guest was shown, compared (never used) so the server can
   * answer price_changed with the new quote.
   */
  expectedTotalSatang: number;
  /** The amount due now (deposit) the guest was shown - what Beam will charge; compared like the total. */
  expectedDueNowSatang: number;
  /** Preview theme to keep across the Beam round trip (no PII; validated server-side). */
  theme?: ThemeName;
  /**
   * The booking terms version (catalogue POLICY_VERSION) the guest's page showed next to the box they
   * ticked. Stripe modes refuse any other version (terms_changed) before anything is held, so the version
   * recorded with the payment (msv_terms, the PAID note) is always the one the guest saw.
   */
  termsVersion?: string;
  /**
   * Guest details. REQUIRED when config.requiresGuestDetails (stripe modes):
   * passed to Cloudbeds (the reservation) and Stripe (receipt email) only -
   * never stored by us, never put in tokens, URLs, logs or analytics. Ignored
   * (not read) in demo/beam modes.
   */
  guest?: GuestDetails;
}

export interface CheckoutSuccess {
  ok: true;
  ref: string;
  /** Absolute URL for a top-level redirect (Beam hosted page or the demo page). */
  redirectUrl: string;
  paymentMode: PaymentMode;
  dataSource: DataSource;
  quote: Quote;
  expiresAt: string;
  /**
   * Beam modes only: a signed token that also carries the Beam payment link
   * id (unknown when the redirect URLs were built). Store it in sessionStorage
   * (see rememberLinkToken in apiClient.ts) BEFORE redirecting; the return
   * page sends it to /api/booking/status as `l`. null in demo mode.
   */
  linkToken: string | null;
  /** demo | beam | stripe. */
  provider: PaymentProvider;
  /** Cloudbeds reservation id of the hold (stripe modes; null otherwise). Not PII. */
  holdReservationId: string | null;
}

export interface CheckoutFailure extends ApiError {
  /** Present for price_changed: the fresh server quote. */
  quote?: Quote;
  /** Present for unavailable: slugs that can no longer be booked. */
  unavailableSlugs?: string[];
  /**
   * Present for unavailable: the subset of unavailableSlugs that is still free
   * but can't be booked online for the cart's party size (Cloudbeds occupancy
   * limits) - fewer guests may still work.
   */
  occupancySlugs?: string[];
}

export type CheckoutResponse = CheckoutSuccess | CheckoutFailure;

export type PaymentStatus = "paid" | "pending" | "failed" | "expired" | "cancelled" | "refunded";

export type DemoFailureCode = "CH_CARD_DECLINED" | "CH_INSUFFICIENT_FUNDS";

/** Booking facts carried in the signed token (no PII). */
export interface BookingSummary {
  ref: string;
  paymentMode: PaymentMode;
  checkIn: IsoDate;
  checkOut: IsoDate;
  nights: number;
  items: CartItemInput[];
  /** Room total (incl. plan supplement, excl. add-ons) per item, parallel to items. */
  itemRoomSatang: number[];
  /**
   * Stripe: per item (parallel to items), the discounted Cloudbeds rate it was booked on - its label and the room
   * at the base rate (struck through on the return page) - or null. Absent in tokens from before it existed.
   */
  itemDiscounts?: (BookingItemDiscount | null)[];
  promoCode: string | null;
  totalSatang: number;
  cardFeeSatang: number;
  dueNowSatang: number;
  createdAt: string;
  linkExpiresAt: string;
  /** Preview theme, so the return/cancel pages keep the look the guest chose. */
  theme?: ThemeName;
}

export interface BookingItemDiscount {
  kind: DiscountKind;
  /** "Direct rate - code DIRECT", or the automatic discount plan's public name. */
  label: string;
  /** The room at the base rate (>= the item's itemRoomSatang). */
  listSatang: number;
}

/**
 * Whether the paid booking is confirmed in Cloudbeds (stripe modes).
 * - not_applicable: demo/beam (no reservation is written).
 * - awaiting_payment: the hold exists, payment not (yet) complete.
 * - confirming: payment received, the Cloudbeds confirmation is still running or retrying.
 * - confirmed: Cloudbeds reservation confirmed with the payment recorded.
 * - needs_attention: paid, but something needs a human (e.g. the hold was cancelled) - show WhatsApp.
 * - released: the hold was cancelled (payment expired, failed or abandoned).
 */
export type FulfilmentState = "not_applicable" | "awaiting_payment" | "confirming" | "confirmed" | "needs_attention" | "released";

export interface FulfilmentView {
  state: FulfilmentState;
  /** Cloudbeds reservationID once confirmed (or for needs_attention); null otherwise. */
  reservationId: string | null;
}

/**
 * Present ONLY when a GA4 purchase may be sent: stripe-live on the production
 * deployment, paid, and confirmed in Cloudbeds. transactionId = Cloudbeds
 * reservationID (as the Cloudbeds engine's own purchase events); value in baht.
 */
export interface PurchaseView {
  transactionId: string;
  valueBaht: number;
  currency: "THB";
}

/** GET /api/booking/status?t=token[&p=demoProof][&l=linkToken][&s=checkoutSessionId] */
export interface StatusResponse {
  ok: true;
  ref: string;
  paymentMode: PaymentMode;
  provider: PaymentProvider;
  status: PaymentStatus;
  failureCode: string | null;
  booking: BookingSummary;
  fulfilment: FulfilmentView;
  purchase: PurchaseView | null;
  checkedAt: string;
}

/** POST /api/booking/abandon { t, l?, s? } - the guest came back via Cancel/Back: expire the Stripe session and release the hold. */
export interface AbandonRequest {
  t: string;
  l?: string | null;
  s?: string | null;
}

/**
 * released: session expired and the Cloudbeds hold cancelled (inventory free again).
 * paid: the session was already paid - nothing was cancelled (show the return page instead).
 * pending: the payment is still processing - nothing was cancelled.
 * closed: nothing to do (already released or unknown session).
 * not_applicable: demo/beam modes.
 */
export type AbandonState = "released" | "paid" | "pending" | "closed" | "not_applicable";

export type AbandonResponse = { ok: true; state: AbandonState } | ApiError;

/** POST /api/booking/mock-stripe - stripe-mock mode only (404 otherwise). */
export type MockStripeAction = "pay" | "pay_delayed_success" | "pay_delayed_failure" | "cancel" | "expire";

export interface MockStripeRequest {
  sessionId: string;
  action: MockStripeAction;
}

export type MockStripeResponse = { ok: true; redirectUrl: string } | ApiError;

export type DemoPayOutcome = "paid" | "declined" | "insufficient_funds";

/** POST /api/booking/demo-pay  { t, outcome } - demo mode only, never card data. */
export interface DemoPayRequest {
  t: string;
  outcome: DemoPayOutcome;
}

export type DemoPayResponse =
  | { ok: true; status: "paid"; returnUrl: string }
  | { ok: true; status: "failed"; failureCode: DemoFailureCode }
  | ApiError;

/* ------------------------------------------------------------------ */
/* Inventory providers (server)                                        */
/* ------------------------------------------------------------------ */

/** Raw availability + room-only nightly rates for one bookable room type. */
export interface RoomInventory {
  slug: string;
  available: boolean;
  remaining: number;
  /** One entry per night of the stay; empty when unavailable. */
  baseNightly: NightRate[];
  /** Stay extra charge keyed by adult count (Cloudbeds adultsExtraCharge); absent = none. */
  adultsExtraSatang?: Record<string, number>;
  /** Cloudbeds' maxGuests for the room type; absent = use the site's rooms.ts figure. */
  maxGuests?: number;
  /** Cloudbeds roomRateID of the row that was priced (sent with the hold so Cloudbeds prices the same rate). */
  rateId?: string;
  /**
   * Set when the row priced is a discounted Cloudbeds rate - the Direct (promo code) rate or an automatic
   * discount plan: rateId is its roomRateID, and this is the base (BAR) row it is derived from (struck through
   * on the page, and checked with it for stay rules at checkout).
   */
  discount?: InventoryDiscount;
  /**
   * A promo code was asked for, but no sellable Direct row came back for this room (or an automatic discount
   * is cheaper): the base row, or that discount, is priced.
   */
  promoNotApplied?: boolean;
}

/** RoomInventory.discount. */
export interface InventoryDiscount {
  kind: DiscountKind;
  /** The plan's public name in Cloudbeds (getRatePlans), e.g. "Long term booking" or "Direct booking rate". */
  name: string;
  /**
   * kind direct, for a promo code other than the DIRECT alias (e.g. LONGSTAY): the rate is labelled with the plan's
   * public name (`name`) instead of "Direct rate".
   */
  showName?: true;
  baseRateId: string;
  baseNightly: NightRate[];
  baseAdultsExtraSatang: Record<string, number>;
}
