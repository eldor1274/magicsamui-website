// Shared types for the own-booking-engine preview (/booking-preview).
//
// Rules that keep this folder runnable under `node --test` (Node 24 strips
// types natively): relative imports with explicit ".ts" extensions, `import
// type` for type-only imports, and erasable TypeScript only (no enums,
// namespaces or parameter properties).
//
// Money is ALWAYS integer satang (1 THB = 100 satang) and named *Satang.
// Dates are ISO calendar dates "YYYY-MM-DD" in Asia/Bangkok (property-local).

export type IsoDate = string;

export type PaymentMode = "demo" | "beam-playground" | "beam-live";

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
}

export interface StaySearch {
  checkIn: IsoDate;
  checkOut: IsoDate;
  adults: number;
  promo?: string;
}

export type PromoResult =
  | { code: string; valid: true; pct: number; label: string }
  | { code: string; valid: false; message: string };

/** Pricing knobs the client needs to mirror the server quote. */
export interface PricingConfig {
  cardFeePct: number;
  depositPct: number;
}

/** Non-secret config the browser may see. */
export interface PublicBookingConfig extends PricingConfig {
  paymentMode: PaymentMode;
  /** "locked" when live Beam credentials are configured without every live-mode condition. */
  paymentStatus: "ok" | "locked";
  dataSource: "demo" | "cloudbeds";
  merchantName: string;
  maxNights: number;
  bookingWindowMonths: number;
  maxSearchAdults: number;
  /** True when a promo code can be valid (the DIRECT demo discount is off in every Beam mode). */
  promoEnabled: boolean;
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
  addons: QuoteAddonLine[];
  addonsSatang: number;
}

export interface QuotePromo {
  code: string;
  pct: number;
  label: string;
  discountSatang: number;
}

export interface Quote {
  currency: "THB";
  checkIn: IsoDate;
  checkOut: IsoDate;
  nights: number;
  lines: QuoteLine[];
  roomsSubtotalSatang: number;
  addonsSubtotalSatang: number;
  promo: QuotePromo | null;
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
  promoCode: string | null;
  totalSatang: number;
  cardFeeSatang: number;
  dueNowSatang: number;
  createdAt: string;
  linkExpiresAt: string;
  /** Preview theme, so the return/cancel pages keep the look the guest chose. */
  theme?: ThemeName;
}

/** GET /api/booking/status?t=token[&p=demoProof][&l=linkToken] */
export interface StatusResponse {
  ok: true;
  ref: string;
  paymentMode: PaymentMode;
  status: PaymentStatus;
  failureCode: string | null;
  booking: BookingSummary;
  checkedAt: string;
}

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
}
