// Hold-first Stripe checkout (WI-5 server side). Runs after checkout.ts has
// validated the cart and re-quoted it from Cloudbeds with no cache:
//
//   test-mode guard -> open-holds brake -> hold INTENT recorded (before any
//   Cloudbeds write) -> lock every physical unit in the cart -> refuse a cart
//   that overlaps one of OUR open holds (units + dates in Redis) ->
//   restrictions + availability re-checked under the lock (no cache) ->
//   postReservation (the HOLD: exact roomTypeID + priced roomRateID, guest
//   details, thirdPartyIdentifier = MSV ref (+ -TEST outside live),
//   sendEmailConfirmation=false, sourceID) -> hold record (units + dates) ->
//   unlock -> assert Cloudbeds grandTotal AND the folio read back ==
//   our room subtotal, with no Cloudbeds taxes/fees (else cancel +
//   price_changed, or "message us" when Cloudbeds adds fees) -> status
//   "not_confirmed" -> Stripe Checkout Session -> redirect.
//
// The route has 30 s (maxDuration): a deadline is passed in, and the chain
// refuses to start a hold it may not have time to finish or cancel, and
// sizes the Stripe call to the time that is left.
//
// The hold takes the unit out of Booking.com/Airbnb before the guest pays, so
// we never charge for a room we don't hold. Any failure after the hold
// cancels it again (and expires the Stripe session if one exists). A hold
// whose outcome is unknown (timeout/5xx) stays in the intent index, and the
// sweeper finds and releases it by its thirdPartyIdentifier. Personal data
// goes only to Cloudbeds and Stripe.
//
// The chain itself is startHoldFirstCheckout (holdFirstCheckout.ts), which
// leaves only the payment page to the provider. This file keeps its
// constants and helpers (the checks before the hold, the price check,
// holdFailed) and the Stripe side: stripeCheckoutAdapter (the Checkout
// Session as the payment page) and startStripeCheckout, the core with it.

import { createHash } from "node:crypto";
import { getCatalogueRoom } from "./catalogue.ts";
import type { PromoRestrictionInput } from "./cloudbedsProvider.ts";
import { CloudbedsWriteError, MIN_CALL_MS, redactForLog } from "./cloudbedsWrite.ts";
import type { ReservationInfo } from "./cloudbedsWrite.ts";
import { MERCHANT_NAME, PAYMENT_LINK_TTL_MINUTES } from "./config.ts";
import type { StripeSettings } from "./config.ts";
import { addMonths, compareIso } from "./dates.ts";
import type { GuestDetails } from "./guest.ts";
import { startHoldFirstCheckout } from "./holdFirstCheckout.ts";
import type { CheckoutAdapter } from "./holdFirstCheckout.ts";
import type { KvStore } from "./kv.ts";
import { acquireLock, keyScope, keys, readJson, releaseLock } from "./lock.ts";
import type { HoldRecord, Lock } from "./lock.ts";
import { isLiveMode } from "./payments/provider.ts";
import { STRIPE_MAX_CHARGE_SATANG, buildCheckoutSessionParams, isStripeCheckoutUrl, stripeErrorInfo } from "./payments/stripe.ts";
import type { CoreDeps, StripeDeps } from "./stripeDeps.ts";
import { STALE_HOLD_MS, SWEEP_STALE_ALERT_MS } from "./sweep.ts";
import type { CartItemInput, CheckoutFailure, CheckoutResponse, DataSource, IsoDate, Quote, RoomInventory, ThemeName } from "./types.ts";
import { stripeCancelUrl, stripeReturnUrl } from "./urls.ts";

/** A unit lock outlives the slowest restrictions + postReservation chain. */
export const UNIT_LOCK_TTL_SECONDS = 90;
/** How long a checkout waits for another checkout holding the same unit. */
export const UNIT_LOCK_WAIT_MS = 8_000;
/** Refuse new holds while this many are open (hold-inventory abuse brake; the property has 6 physical units). */
export const MAX_OPEN_HOLDS = 8;
/** Holds one guest (hashed IP + email) may create per hold lifetime window. */
export const MAX_HOLDS_PER_CLIENT = 5;
/** Holds one connection (hashed IP) may create per window: hotel Wi-Fi / mobile carrier NAT share an IP. */
export const MAX_HOLDS_PER_IP = 15;
/** The client brake window (the hold lifetime incl. margin), in minutes - also shown to the guest. */
export const CLIENT_BRAKE_MINUTES = Math.round(STALE_HOLD_MS / 60_000);
/** Time a checkout must have left before it writes a hold (postReservation may take 15 s, then a cancel). */
export const HOLD_MIN_REMAINING_MS = 17_000;
/** Time needed for the payment page's call after the hold (else the hold is given back at once). */
export const SESSION_MIN_REMAINING_MS = 4_000;
/** Kept back from the payment page's call for cancelling the hold if it fails. */
export const CANCEL_RESERVE_MS = 2_500;
/** Time needed to read the hold's folio back and still make the payment page's call (or a cancel) afterwards. */
export const FOLIO_CHECK_MIN_REMAINING_MS = MIN_CALL_MS + SESSION_MIN_REMAINING_MS + CANCEL_RESERVE_MS;
/** Pause before the one retry of a failed folio read. */
export const FOLIO_RETRY_PAUSE_MS = 400;
/** Extra charges up to this share of the rooms read as a Cloudbeds source fee (the classic engine's is 5%). */
export const MAX_SOURCE_FEE_PCT = 15;
/** Checkouts refused on Cloudbeds reads within the window before the owner is alerted. */
export const READ_FAILURE_ALERT_COUNT = 3;

/** The checkout's cart, guest and server quote. Nothing in it is Stripe's: the hold-first core takes it as it is. */
export interface StripeCheckoutInput {
  checkIn: IsoDate;
  checkOut: IsoDate;
  items: CartItemInput[];
  guest: GuestDetails;
  quote: Quote;
  inventory: RoomInventory[];
  dataSource: DataSource;
  theme?: ThemeName;
  today: IsoDate;
  /**
   * Fresh (no cache) availability re-check run UNDER the unit lock, right
   * before postReservation. Returns the cart slugs that are no longer free.
   */
  recheckAvailability?: () => Promise<string[]>;
  /**
   * The guest's code (direct-rate), when the server's re-quote put rooms on a Cloudbeds promo-code rate - the Direct
   * rate for DIRECT, or the plan of another code (inventory rows carrying a "direct" `discount`): those rows' rateIds
   * are, with the automatic discount rows the re-quote selected, the only derived rates this checkout may hold, and the
   * hold is sent with Cloudbeds' promo code (`cloudbedsCode`, as Cloudbeds spells it). generic: a code other than the
   * DIRECT alias - the guest's messages and the owner's alerts name its plan instead of "the Direct rate". null/absent =
   * no promo-code rate.
   */
  promo?: { code: string; cloudbedsCode: string; generic?: true } | null;
}

export interface StripeCheckoutContext {
  deps: StripeDeps;
  origin: string;
  nowMs: number;
  pickRefChar?: (max: number) => number;
  nonce?: () => string;
  /** The client's IP (hashed before use; never stored or logged in clear). */
  clientIp?: string | null;
  /** Value of the Stage B staff cookie (testAccess.ts), if the browser sent one. */
  testAccessToken?: string | null;
  sleep?: (ms: number) => Promise<void>;
  /** Overrides UNIT_LOCK_WAIT_MS (tests). */
  unitLockWaitMs?: number;
  /**
   * Wall-clock deadline (ms, `clock` time) by which the route must answer
   * (its maxDuration minus a margin). Absent = no time budget (tests).
   */
  deadlineMs?: number;
  /** Wall clock for the deadline (default Date.now; independent of nowMs, which may be pinned). */
  clock?: () => number;
}

export interface StripeCheckoutResult {
  status: number;
  body: CheckoutResponse;
}

export function fail(status: number, body: Omit<CheckoutFailure, "ok">): StripeCheckoutResult {
  return { status, body: { ok: false, ...body } };
}

export const NOTHING_CHARGED = "Nothing has been charged.";
export const LIVE_UNCONFIRMED = `We could not confirm live availability. ${NOTHING_CHARGED} Please try again in a moment.`;
export const MESSAGE_US = "Message us on WhatsApp and we'll complete the booking for you.";

/** One Stripe idempotency key per booking attempt (same ref + salt -> same key). */
export function stripeIdempotencyKey(ref: string, mode: string, salt: string): string {
  return `msv-cs-${createHash("sha256").update(`stripe-checkout|${mode}|${ref}|${salt}`).digest("hex").slice(0, 40)}`;
}

/**
 * The guard for Stripe test mode with REAL Cloudbeds writes. null = allowed.
 * Needs the staff access cookie AND the test guest email AND a far arrival.
 * The messages never say what the guard checks (the email is not a secret).
 */
export function testModeRefusal(
  guard: { guestEmail: string | null; minArrivalMonths: number; accessKey?: string | null } | null,
  checkIn: IsoDate,
  guestEmail: string,
  today: IsoDate,
  accessGranted = false,
): string | null {
  if (!guard) return null;
  if (!guard.guestEmail || !guard.accessKey) return "Test mode is not set up for real reservations. Nothing was reserved or charged.";
  if (!accessGranted || guestEmail.trim().toLowerCase() !== guard.guestEmail) {
    return "Test mode: real reservations can't be created from this browser with these details. Nothing was reserved or charged.";
  }
  if (compareIso(checkIn, addMonths(today, guard.minArrivalMonths)) < 0) {
    return `Test mode: please choose an arrival at least ${guard.minArrivalMonths} months ahead. Nothing was reserved or charged.`;
  }
  return null;
}

/** Guest-facing sentences for a Cloudbeds stay rule (exported for the booking page classifier test). */
export const RESTRICTION_MESSAGES: Record<string, (name: string, n?: number) => string> = {
  closed_to_arrival: (name) => `${name} can't be booked with arrival on this date - please try another arrival day.`,
  closed_to_departure: (name) => `${name} can't be booked with departure on this date - please try another departure day.`,
  min_stay: (name, n) => `${name} needs a minimum stay of ${n} nights for these dates.`,
  max_stay: (name, n) => `${name} can be booked for at most ${n} nights for these dates.`,
  blocked: (name) => `Sorry - ${name} is no longer available for these dates.`,
  sold_out: (name) => `Sorry - ${name} is no longer available for these dates.`,
  // Not a stay rule: the rate found is a derived plan (Stripe sells the base rate only, and the discounted rate - Direct or automatic - selected for the booking).
  derived_rate: (name) => `Sorry - ${name} can't be booked online for these dates right now. ${NOTHING_CHARGED} ${MESSAGE_US}`,
};

/**
 * The guest's message when Cloudbeds priced a promo-code hold at the base rate (the hold was cancelled): "the Direct
 * rate" for DIRECT, the plan's name for another code (`plans`: the code's plans in the cart).
 */
export function directAtBaseMessage(code: string, plans: string[] = []): string {
  const rate = plans.length === 0 ? "the Direct rate" : plans.length === 1 ? `our "${plans[0]}" rate` : "our discounted rate";
  return `We couldn't reserve your room at ${rate} online just now. ${NOTHING_CHARGED} Book with code ${code} on our classic booking page, where it applies, or message us on WhatsApp and we'll book it for you.`;
}

/** The owner's alert subject for it: fixed, so every such refusal raises (and repeats) one alert. */
export const DIRECT_AT_BASE_ALERT = "DIRECT bookings blocked: Cloudbeds priced the Direct rate at the base rate - set BOOKING_DIRECT_PROMO=off and redeploy";

/** "the "Long term" rate" / "the "A" and "B" rates": a promo code's plans in an alert. */
export function codePlansText(plans: string[]): string {
  if (plans.length === 0) return "the code's rate";
  return plans.length === 1 ? `the "${plans[0]}" rate` : `the ${plans.map((p) => `"${p}"`).join(" and ")} rates`;
}

/**
 * The owner's alert subject when Cloudbeds priced the rate of a promo code other than DIRECT at the base rate (its key
 * is fixed per code: one alert per code and mode). It names the code and the switch, which turns off EVERY code.
 */
export function codeAtBaseAlert(code: string, plans: string[]): string {
  return `Code ${code} bookings blocked: Cloudbeds priced ${codePlansText(plans)} at the base rate - set BOOKING_DIRECT_PROMO=off and redeploy`;
}

/** The names of the promo-code rates the quote's rooms are on ("Direct rate" for DIRECT, the plans' public names for another code). */
export function codeRateNames(quote: Quote): string[] {
  return [...new Set(quote.lines.flatMap((l) => (l.listRoomSatang !== undefined && l.discount?.kind === "direct" ? [l.discount.name] : [])))];
}

/** The fixed-key alert for a promo-code hold priced at the base rate: DIRECT's own, or one per other code (naming its plans). */
export function codeAtBaseAlertOf(input: StripeCheckoutInput, quote: Quote): { subject: string; key: string; code: string; plans: string[] } {
  const code = quote.directRate?.code ?? input.promo?.code ?? "DIRECT";
  if (!input.promo?.generic) return { subject: DIRECT_AT_BASE_ALERT, key: "direct-at-base", code, plans: [] };
  const plans = codeRateNames(quote);
  return { subject: codeAtBaseAlert(code, plans), key: `code-at-base:${code}`, code, plans };
}

/** The fix line of a non-DIRECT code's at-base alert: the switch turns off every code, and dropping the code from the plan is no fix. */
export const CODE_AT_BASE_FIX =
  "Fix now: set BOOKING_DIRECT_PROMO=off in Vercel and redeploy. That switches off EVERY code on the own page, DIRECT included: guests who enter a code are sent to /booking/classic, and bookings without a code are not affected. Then ask Cloudbeds support how postReservation applies the plan's rate (rooms[0][roomRateID] + promoCode) before switching it back on. Removing the code from the plan in Cloudbeds is no fix: a plan without a code whose public name starts with one of BOOKING_AUTO_DISCOUNT_PLANS (e.g. \"Long term\") is then sold automatically.";

/** The guest's message when Cloudbeds priced an automatic-discount hold at the base rate (the hold was cancelled). */
export function autoAtBaseMessage(names: string[]): string {
  const rate = names.length === 1 ? `our "${names[0]}" rate` : "our discounted rate";
  return `We couldn't reserve your room at ${rate} online just now. ${NOTHING_CHARGED} Book on our classic booking page, or message us on WhatsApp and we'll book it for you.`;
}

/** The start of that alert's subject (its key is fixed: one alert per mode, whichever plan it names). */
export const AUTO_AT_BASE_ALERT_PREFIX = "Automatic discounts blocked:";

/** The owner's alert subject when Cloudbeds priced an automatic discount plan at the base rate. */
export function autoAtBaseAlert(plan: string): string {
  return `${AUTO_AT_BASE_ALERT_PREFIX} Cloudbeds priced ${plan} at the base rate - set BOOKING_AUTO_DISCOUNTS=off and redeploy`;
}

/** Where a derived rate plan is opened to the own page's reservation source (postReservation refused it). */
export function rateSourceFixLine(plan: string): string {
  return `In Cloudbeds: Rates and Availability > Rate Plans & Packages > ${plan} > 'Which sources is rate plan available for?' > tick the own booking page's source (CLOUDBEDS_SOURCE_ID), save.`;
}

/** postReservation's refusal of a rate not open to the reservation's source (live, 2026-10-07: "Rate 3195765 is not available for this reservation. ..."). */
export const RATE_NOT_FOR_SOURCE_RE = /not available for this reservation/i;

/**
 * True when a postReservation refusal reads like "no availability". Used ONLY
 * when no live re-check is possible (simulated data): with live data a refusal
 * counts as "sold" only when a fresh availability read confirms it, because
 * this test also matches setup errors ("Rate is not available", "Invalid
 * allotment block") that would hit every booking and must be alerted.
 */
export function isAvailabilityRefusal(message: string): boolean {
  return /availab|sold.?out|no rooms|not enough rooms|overbook|fully booked|no inventory|allotment/i.test(message);
}

/** The hold next to the quote (classifyHoldTotal). */
export type HoldTotalCheck =
  | { kind: "match" }
  /** No total could be verified: never charge on it. */
  | { kind: "unreadable" }
  /** Cloudbeds put its own taxes/fees on the hold: a source setting that hits EVERY online booking. */
  | { kind: "cloudbeds_fees"; extraSatang: number; pctOfRooms: string }
  /**
   * The quote is on a promo-code rate (the Direct rate, or another code's plan) but Cloudbeds priced the hold at
   * exactly the BASE rate: it ignored the roomRateID / promoCode (the Reservation FAQ's unconfirmed claim). Hits
   * EVERY booking with the code.
   */
  | { kind: "promo_at_base"; totalSatang: number }
  /**
   * The quote has rooms on an automatic discount plan, and Cloudbeds priced exactly those rooms at the BASE
   * rate (it ignored their roomRateID): hits every booking on that plan. alsoDirect: the Direct rooms of the
   * same cart were priced at the base rate too.
   */
  | { kind: "auto_at_base"; totalSatang: number; alsoDirect: boolean }
  /** Any other difference (a rate changed, another rate plan): price_changed. */
  | { kind: "price_changed"; totalSatang: number; pctOfQuote: string };

/** part/whole in percent with 2 decimals ("5.00"), via basis points. */
function pct2(part: number, whole: number): string {
  return (Math.round((part * 10_000) / whole) / 100).toFixed(2);
}

/**
 * The price check on a hold (pure). Exact satang equality with the quoted room subtotal is the ONLY
 * pass: postReservation's grandTotal (when given) AND the folio read back with getReservation must both
 * equal it, and the folio must carry no taxes/fees or additional items (when readable). A refusal is
 * classified so the owner hears what to fix: taxes/fees on the folio, or a total at most
 * MAX_SOURCE_FEE_PCT above the quote while the rooms equal it, is Cloudbeds adding fees for the
 * reservation's source; a quote held at exactly its total with the discounted rooms at their base rate is
 * Cloudbeds ignoring that discount - the automatic discount rooms (`autoBaseRoomsSatang`; checked first,
 * since the Direct rate is proven in Stage B), the Direct rooms (`baseRoomsSatang`), or both; anything
 * else is a price change.
 */
export function classifyHoldTotal(input: {
  quotedRoomsSatang: number;
  /** postReservation's grandTotal; null = not given. */
  holdTotalSatang: number | null;
  /** The folio read back; null = not read (or the read failed). */
  folio: Pick<ReservationInfo, "grandTotalSatang" | "subTotalSatang" | "taxesFeesSatang" | "additionalItemsSatang"> | null;
  /** The quote is on the Direct rate: its rooms with the Direct ones at the base rate (quote.directRate.baseRoomsSatang). */
  baseRoomsSatang?: number | null;
  /** The quote has automatic discounts: its rooms with those at the base rate (quote.autoDiscount.baseRoomsSatang). */
  autoBaseRoomsSatang?: number | null;
}): HoldTotalCheck {
  const quoted = input.quotedRoomsSatang;
  const folioTotal = input.folio?.grandTotalSatang ?? null;
  const added = (input.folio?.taxesFeesSatang ?? 0) + (input.folio?.additionalItemsSatang ?? 0);
  const differing = [folioTotal, input.holdTotalSatang].find((t): t is number => t !== null && t !== quoted) ?? null;
  const rooms = input.folio?.subTotalSatang ?? null;
  // Cloudbeds' own charges on the folio: never a pass, whatever the totals say.
  if (added > 0) return { kind: "cloudbeds_fees", extraSatang: added, pctOfRooms: pct2(added, rooms !== null && rooms > 0 ? rooms : quoted) };
  // Nothing differs: a pass only once the folio itself was read back.
  if (differing === null) return folioTotal === null ? { kind: "unreadable" } : { kind: "match" };
  // A discount Cloudbeds ignored: exactly the rooms on it at their base rate (the folio's rooms say the same when read).
  const atBase = (total: number | null) => total !== null && total !== quoted && differing === total && (rooms === null || rooms === total);
  const direct = input.baseRoomsSatang ?? null;
  const auto = input.autoBaseRoomsSatang ?? null;
  if (atBase(auto)) return { kind: "auto_at_base", totalSatang: differing, alsoDirect: false };
  if (atBase(direct)) return { kind: "promo_at_base", totalSatang: differing };
  if (auto !== null && direct !== null && atBase(auto + direct - quoted)) return { kind: "auto_at_base", totalSatang: differing, alsoDirect: true };
  const extra = differing - quoted;
  if (extra > 0 && rooms === quoted && extra * 100 <= quoted * MAX_SOURCE_FEE_PCT) {
    return { kind: "cloudbeds_fees", extraSatang: extra, pctOfRooms: pct2(extra, quoted) };
  }
  return { kind: "price_changed", totalSatang: differing, pctOfQuote: `${extra > 0 ? "+" : ""}${pct2(extra, quoted)}` };
}

/** Opaque per-client key: a keyed hash of the IP (the IP itself is never stored). */
export function clientKeyOf(secret: string, ip: string): string {
  return createHash("sha256").update(`msv-client|${secret}|${ip}`).digest("hex").slice(0, 32);
}

/** Every physical unit the cart occupies (combination room types share units with their suites). */
export function cartUnits(items: CartItemInput[]): string[] {
  return [...new Set(items.flatMap((i) => getCatalogueRoom(i.slug)?.units ?? []))].sort();
}

/**
 * Takes the lock of every unit (sorted, so two carts can never deadlock),
 * waiting up to `waitMs` for another checkout to finish. null = still busy.
 */
export async function lockUnits(
  kv: KvStore,
  units: string[],
  waitMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<Lock[] | null> {
  const started = Date.now();
  for (;;) {
    const got: Lock[] = [];
    let all = true;
    for (const unit of [...new Set(units)].sort()) {
      const lock = await acquireLock(kv, keys.unitLock(unit), UNIT_LOCK_TTL_SECONDS);
      if (!lock) {
        all = false;
        break;
      }
      got.push(lock);
    }
    if (all) return got;
    for (const lock of got) await releaseLock(kv, lock).catch(() => undefined);
    if (Date.now() - started >= waitMs) return null;
    await sleep(250);
  }
}

export async function unlockAll(kv: KvStore, locks: Lock[]): Promise<void> {
  for (const lock of locks) await releaseLock(kv, lock).catch(() => undefined);
}

/** True when two stays share at least one night ([checkIn, checkOut) ranges). */
function staysOverlap(aIn: string, aOut: string, bIn: string, bOut: string): boolean {
  return compareIso(aIn, bOut) < 0 && compareIso(bIn, aOut) < 0;
}

/**
 * Holds younger than this are read by the overlap check. Only fresh holds need
 * bridging: an older one shows in Cloudbeds' own availability (a hold lives
 * ~31 minutes unless paid, and a paid one is a Cloudbeds booking).
 */
export const OVERLAP_WINDOW_MS = 2 * 3600_000;

/**
 * Cart slugs that overlap one of OUR open holds (same physical unit, a shared
 * night). Runs under the unit lock, so it does not depend on Cloudbeds'
 * availability already showing a hold another checkout just wrote. Reads only
 * the holds created in the last OVERLAP_WINDOW_MS, so old index entries can
 * never push a fresh hold out of the scanned set.
 */
export async function slugsOverlappingOpenHolds(
  kv: KvStore,
  items: CartItemInput[],
  checkIn: IsoDate,
  checkOut: IsoDate,
  nowMs: number,
): Promise<string[]> {
  const ids = await kv.zrangeByScore(keys.holdIndex(), nowMs - OVERLAP_WINDOW_MS, Number.MAX_SAFE_INTEGER, 200);
  const out = new Set<string>();
  for (const id of ids) {
    const rec = await readJson<HoldRecord>(kv, keys.hold(id));
    if (!rec?.units || !rec.checkIn || !rec.checkOut) continue;
    if (!staysOverlap(rec.checkIn, rec.checkOut, checkIn, checkOut)) continue;
    for (const item of items) {
      const units = getCatalogueRoom(item.slug)?.units ?? [];
      if (units.some((u) => rec.units?.includes(u))) out.add(item.slug);
    }
  }
  return [...out];
}

/**
 * A checkout was refused because a Cloudbeds READ failed (restrictions,
 * availability). One failure is a blip; several within half an hour mean the
 * read key, its scopes or Cloudbeds itself: every guest is being turned away.
 */
export async function noteCheckoutReadFailure(deps: Pick<CoreDeps, "kv" | "alert" | "log" | "config">, step: string, error: string): Promise<void> {
  try {
    const n = await deps.kv.incr(keys.checkoutReadFailures(keyScope(deps.config.paymentMode)), 30 * 60);
    if (n < READ_FAILURE_ALERT_COUNT) return;
    await deps.alert(
      "Online bookings failing: Cloudbeds availability can't be read",
      [
        `${n} checkouts in the last half hour were refused because reading Cloudbeds failed (latest: ${step} - ${redactForLog(error).slice(0, 200)}). Guests are told to try again; nothing was reserved or charged.`,
        "Check the Cloudbeds read key (CLOUDBEDS_API_KEY) and its scopes, and Cloudbeds' status. Guests can still book on /booking/classic or WhatsApp.",
      ],
      { key: "checkout-cloudbeds-reads", severity: "warning" },
    );
  } catch {
    // Best effort only.
  }
}

/**
 * The discounted rate the server's re-quote selected for a room (never anything the browser sent), as the stay-rule
 * check under the lock re-confirms it: a promo-code rate (the Direct rate, or another code's plan, with the guest's
 * valid code: its promo code as Cloudbeds spells it) or an automatic discount plan
 * (the configured plan prefixes). null = the base rate - or a discount the deployment can't confirm, which the
 * check then refuses as derived.
 */
function selectedDiscount(inv: RoomInventory | undefined, input: StripeCheckoutInput, deps: CoreDeps): PromoRestrictionInput | null {
  const d = inv?.discount;
  if (!d) return null;
  if (d.kind === "direct") return input.promo ? { cloudbedsCode: input.promo.cloudbedsCode, baseRateId: d.baseRateId } : null;
  const plans = deps.config.cloudbeds?.autoDiscountPlans ?? [];
  return plans.length > 0 ? { kind: "auto", plans, baseRateId: d.baseRateId } : null;
}

/** Our own open holds, then restrictions + availability fresh from Cloudbeds. Runs under the unit lock. null = clear to hold. */
export async function checkBeforeHold(input: StripeCheckoutInput, deps: CoreDeps, nowMs: number): Promise<StripeCheckoutResult | null> {
  let overlapping: string[];
  try {
    overlapping = await slugsOverlappingOpenHolds(deps.kv, input.items, input.checkIn, input.checkOut, nowMs);
  } catch (e) {
    deps.log("checkout_kv_failed", { step: "overlap", error: redactForLog(e instanceof Error ? e.message : String(e)) });
    return fail(503, { error: "payment_unavailable", message: `We couldn't start your booking safely just now. ${NOTHING_CHARGED} Please try again in a moment.` });
  }
  if (overlapping.length > 0) {
    deps.log("checkout_refused_open_hold_overlap", { slugs: overlapping });
    return fail(409, {
      error: "unavailable",
      message: `Sorry - another guest is completing a booking for a room in your reservation right now. ${NOTHING_CHARGED} Please choose other dates or rooms, or check again in about ${CLIENT_BRAKE_MINUTES} minutes.`,
      unavailableSlugs: overlapping,
    });
  }
  if (deps.restrictions && input.dataSource === "cloudbeds") {
    for (const item of input.items) {
      const room = getCatalogueRoom(item.slug);
      const inv = input.inventory.find((i) => i.slug === item.slug);
      if (!room?.cloudbedsRoomTypeId) continue;
      // The discounted rate selected for this booking (server re-quote only) - the Direct rate or an automatic discount:
      // checked with its base row, and the one derived rate allowed.
      const promo = selectedDiscount(inv, input, deps);
      let r;
      try {
        r = await deps.restrictions(room.cloudbedsRoomTypeId, inv?.rateId ?? null, input.checkIn, input.checkOut, item.adults, promo);
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        deps.log("checkout_restrictions_failed", { slug: item.slug, error });
        await noteCheckoutReadFailure(deps, "getRatePlans", error);
        return fail(503, { error: "payment_unavailable", message: LIVE_UNCONFIRMED });
      }
      if (r.derived && deps.config.cloudbeds?.baseRateOnly) {
        // Defence in depth: whatever the search-side row choice did, never hold (and charge for) a derived plan.
        const kind = promo ? (promo.kind ?? "direct") : null;
        deps.log("checkout_refused_derived_rate", { slug: item.slug, roomTypeId: room.cloudbedsRoomTypeId, rateId: inv?.rateId ?? null, promo: kind === "direct", auto: kind === "auto" });
        const refused = "The checkout was refused before anything was reserved or charged; the page showed the guest the room as no longer available for these dates.";
        await deps.alert(
          `Online booking refused: ${room.name} was offered on a derived rate`,
          [
            promo?.kind === "auto"
              ? `Rate ${inv?.rateId ?? "(none)"} of room type ${room.cloudbedsRoomTypeId} (${room.name}) was offered as the automatic discount "${inv?.discount?.name ?? "?"}", but Cloudbeds' getRatePlans does not confirm it: it must be listed as a derived plan with no promo code, a public name starting with one of BOOKING_AUTO_DISCOUNT_PLANS (${promo.plans.join(", ")}) and not reading as non-refundable ("non-refundable", "Non-Ref", "NRF", "no refund", "prepaid", "advance purchase"...), derived from the base rate ${promo.baseRateId}. ${refused}`
              : promo && input.promo?.generic
                ? `Rate ${inv?.rateId ?? "(none)"} of room type ${room.cloudbedsRoomTypeId} (${room.name}) was offered as the "${inv?.discount?.name ?? "?"}" rate for code ${input.promo.code} (Cloudbeds promo code ${promo.cloudbedsCode}), but Cloudbeds' getRatePlans does not confirm it: it must be listed with that promo code, under a public name that doesn't read as non-refundable, and be derived from the base rate ${promo.baseRateId}. ${refused}`
                : promo
                  ? `Rate ${inv?.rateId ?? "(none)"} of room type ${room.cloudbedsRoomTypeId} (${room.name}) was offered as the Direct rate (promo code ${promo.cloudbedsCode}), but Cloudbeds' getRatePlans does not confirm it: it must be listed with that promo code and be derived from the base rate ${promo.baseRateId}. ${refused}`
                  : `Cloudbeds' getRatePlans lists rate ${inv?.rateId ?? "(none)"} of room type ${room.cloudbedsRoomTypeId} (${room.name}) as a DERIVED plan (a package or discount), but the own booking page sells only the base (BAR) rate and the discounted rate (a promo code's or automatic) selected for the booking. ${refused}`,
            promo?.kind === "auto"
              ? `Check the plan in Cloudbeds (its public name, promo code and parent rate), or set BOOKING_AUTO_DISCOUNTS=off and redeploy. Guests can still book on /booking/classic.`
              : promo && input.promo?.generic
                ? `Check the "${inv?.discount?.name ?? "?"}" plan in Cloudbeds (its promo code ${promo.cloudbedsCode}, its public name, and that it is derived from the base rate), or set BOOKING_DIRECT_PROMO=off and redeploy (every code off, DIRECT included). Guests can still book with the code on /booking/classic.`
                : promo
                  ? "Check the room type's \"Direct booking rate\" plan in Cloudbeds (its promo code, CLOUDBEDS_PROMO_CODE, and that it is derived from the base rate). Guests can still book with the code on /booking/classic."
                  : "Check the room type's rate plans in Cloudbeds: getAvailableRoomTypes must return the base rate as a non-derived row (named \"default\").",
          ],
          { key: `derived-rate:${room.cloudbedsRoomTypeId}`, severity: "warning" },
        );
        return fail(409, { error: "unavailable", message: RESTRICTION_MESSAGES.derived_rate(room.name), unavailableSlugs: [item.slug] });
      }
      if (r.ok && !r.checked) {
        // No rate row for this room type: min stay / closed to arrival can't be enforced for it.
        deps.log("restrictions_unchecked", { slug: item.slug, roomTypeId: room.cloudbedsRoomTypeId });
        await deps.alert(
          `Stay rules not checked for ${room.name}`,
          [
            `Cloudbeds' getRatePlans returned no rate row for room type ${room.cloudbedsRoomTypeId} (${room.name}), so minimum stay, closed-to-arrival and similar rules were NOT checked for online bookings of it. The booking itself went ahead on live availability.`,
            "Check that the room type has a rate plan in Cloudbeds that the booking API key can read.",
          ],
          { key: `restrictions-unchecked:${room.cloudbedsRoomTypeId}`, severity: "warning" },
        );
      }
      if (!r.ok) {
        const msg = RESTRICTION_MESSAGES[r.reason](room.name, r.minNights ?? r.maxNights);
        return fail(409, { error: "unavailable", message: msg, unavailableSlugs: [item.slug] });
      }
    }
  }
  if (input.recheckAvailability) {
    let gone: string[];
    try {
      gone = await input.recheckAvailability();
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      deps.log("checkout_recheck_failed", { error });
      await noteCheckoutReadFailure(deps, "getAvailableRoomTypes", error);
      return fail(503, { error: "payment_unavailable", message: LIVE_UNCONFIRMED });
    }
    if (gone.length > 0) {
      return fail(409, {
        error: "unavailable",
        message: "Sorry - a room in your reservation was just booked by someone else. Please choose again.",
        unavailableSlugs: gone,
      });
    }
  }
  return null;
}

/** Live only: alert when the sweeper (the only recovery for lost holds) has not run recently. */
export async function checkSweeperFresh(deps: Pick<CoreDeps, "config" | "kv" | "alert">, nowMs: number): Promise<void> {
  if (!isLiveMode(deps.config.paymentMode)) return;
  try {
    const last = Number(await deps.kv.get(keys.lastSweep(keyScope(deps.config.paymentMode))));
    if (Number.isFinite(last) && last > 0 && nowMs - last < SWEEP_STALE_ALERT_MS) return;
    await deps.alert(
      "The booking sweeper has not run recently",
      [
        last > 0
          ? `The last successful sweep was ${Math.round((nowMs - last) / 60_000)} minutes ago.`
          : "No successful sweep has been recorded.",
        "Without it, holds whose payment page was abandoned without a webhook are never released. Check the droplet cron (docs/booking-engine.md 4.D).",
      ],
      { key: "sweeper-stale", severity: "warning" },
    );
  } catch {
    // Best effort only.
  }
}

/**
 * The Stripe side of the hold-first checkout (holdFirstCheckout.ts): the payment page is a Checkout Session, whose
 * id is both the key (every Redis key keeps its name) and the payment id the booking token carries.
 */
export function stripeCheckoutAdapter(
  deps: Pick<StripeDeps, "config" | "stripe">,
  stripe: StripeSettings,
  at: { origin: string; nowMs: number; theme?: ThemeName },
): CheckoutAdapter<ReturnType<typeof stripeErrorInfo>> {
  const mode = deps.config.paymentMode;
  return {
    provider: "stripe",
    brand: "Stripe",
    maxChargeSatang: STRIPE_MAX_CHARGE_SATANG,
    async createPage({ ref, reservationId, quote, guest, token, basePath, guestFlags, budgetMs, nonce }) {
      // Sized to the budget: Stripe's own timeout, and its one network retry only when that still fits.
      const requestOptions = Number.isFinite(budgetMs) ? { timeout: Math.min(15_000, Math.floor(budgetMs)), maxNetworkRetries: budgetMs > 20_000 ? 1 : 0 } : {};
      const params = buildCheckoutSessionParams({
        ref,
        reservationId,
        quote,
        customerEmail: guest.email,
        successUrl: stripeReturnUrl(at.origin, basePath, ref, token, at.theme),
        cancelUrl: stripeCancelUrl(at.origin, basePath, ref, token, at.theme),
        nowMs: at.nowMs,
        ttlMinutes: PAYMENT_LINK_TTL_MINUTES,
        allowedPaymentMethodTypes: stripe.allowedPaymentMethodTypes,
        merchantName: MERCHANT_NAME,
        mode,
        guestFlags,
      });
      const session = await deps.stripe.checkout.sessions.create(params, {
        idempotencyKey: stripeIdempotencyKey(ref, mode, nonce()),
        ...requestOptions,
      });
      return { key: session.id, paymentId: session.id, redirectUrl: session.url };
    },
    // stripe-mock's page is served from our own origin.
    isAllowedUrl: (url) => isStripeCheckoutUrl(url, stripe.mock ? at.origin : null),
    cancelPage: (key) => deps.stripe.checkout.sessions.expire(key),
    errorInfo: stripeErrorInfo,
    // A persistent Stripe-side problem (key permission, PromptPay not activated, account restricted) breaks EVERY booking.
    pageFailedAlert: (info, ref) => ({
      subject: "Booking stopped: Stripe could not create the payment page",
      lines: [
        `Booking ${ref}: Stripe refused or failed to create the Checkout Session (${info.type}${info.code ? `, code ${info.code}` : ""}${info.statusCode ? `, HTTP ${info.statusCode}` : ""}${info.requestId ? `, request ${info.requestId}` : ""}).`,
        "The hold was cancelled and nothing was charged. If this repeats, every online booking is failing: check the restricted key's permissions, the payment methods (PromptPay) and the account status in the Stripe Dashboard.",
      ],
      key: `stripe-session-fail:${info.code ?? info.type}`,
    }),
  };
}

/** The hold-first checkout (holdFirstCheckout.ts) with a Stripe Checkout Session as the payment page. */
export async function startStripeCheckout(input: StripeCheckoutInput, ctx: StripeCheckoutContext): Promise<StripeCheckoutResult> {
  const stripe = ctx.deps.config.stripe;
  if (!stripe) return fail(503, { error: "payment_unavailable", message: `Online payment is not available right now. ${NOTHING_CHARGED}` });
  return startHoldFirstCheckout(input, ctx, stripeCheckoutAdapter(ctx.deps, stripe, { origin: ctx.origin, nowMs: ctx.nowMs, theme: input.theme }));
}

/**
 * The fix lines for a postReservation refusal of a derived rate the plan does not open to the reservation's source
 * ("Rate 3195765 is not available for this reservation. Verify the rate is bookable for these dates and for the
 * reservation source.", live for the Direct rate on 2026-10-07), when the cart holds a discounted rate (a promo code's or
 * automatic). The rate id the message names decides: a cart room's discounted rate -> that plan and where to tick
 * the source; a cart room's BASE rate -> that room's base rate (no discount plan blamed, no discount switch); no cart
 * room's rate (or no id) -> every discounted plan in the cart. When the hold carried the reservation-level promoCode
 * (a room on the code's rate) and the refused rate is not the code's rate, a line says that code may be the cause
 * (Stage B case 24(d)). [] otherwise.
 */
export function rateNotForSourceFix(message: string, input: Pick<StripeCheckoutInput, "items" | "inventory" | "promo">, sourceId: string | null): string[] {
  if (!RATE_NOT_FOR_SOURCE_RE.test(message)) return [];
  const rooms = input.items.map((item) => input.inventory.find((i) => i.slug === item.slug)).filter((inv): inv is RoomInventory => inv !== undefined);
  const held = rooms.filter((inv): inv is RoomInventory & { discount: NonNullable<RoomInventory["discount"]> } => inv.discount !== undefined);
  if (held.length === 0) return [];
  const namedId = /\brate\s+([A-Za-z0-9_-]{1,40})\b/i.exec(message)?.[1] ?? null;
  // The hold was sent with Cloudbeds' promo code for the whole reservation (as in createHold's promoCode).
  const promoSent = Boolean(input.promo) && held.some((inv) => inv.discount.kind === "direct");
  const promoLine = (lead: string, refused: string, plain: string) =>
    `${lead}the hold also carried the reservation-level promoCode (a room on the ${input.promo?.generic ? `code ${input.promo.code}'s` : "Direct"} rate in the same cart), and Cloudbeds may refuse ${refused} under that code (Stage B case 24(d)). If bookings of ${plain} without the code go through, set BOOKING_DIRECT_PROMO=off in Vercel, redeploy and tell the developer.`;
  const named = held.filter((inv) => inv.rateId === namedId);
  const baseNamed = named.length > 0 ? [] : rooms.filter((inv) => namedId !== null && (inv.discount ? inv.discount.baseRateId : inv.rateId) === namedId);
  if (baseNamed.length > 0) {
    const names = [...new Set(baseNamed.map((inv) => getCatalogueRoom(inv.slug)?.name ?? inv.slug))];
    return [
      `Fix: Cloudbeds refused rate ${namedId}, the BASE rate of ${names.join(", ")} in this booking - not a discounted plan, so ticking a source on a discount plan or switching the discounts off does not help. Check in Cloudbeds that this room type's base rate is bookable on these dates and for the own booking page's reservation source${sourceId ? ` (${sourceId})` : ""}.`,
      ...(promoSent ? [promoLine("Also: ", "a room's base rate", "that room")] : []),
    ];
  }
  const plans = [...new Set((named.length > 0 ? named : held).map((inv) => inv.discount.name))];
  const kinds = new Set((named.length > 0 ? named : held).map((inv) => inv.discount.kind));
  return [
    `Fix: Cloudbeds refused a discounted rate this booking holds (${plans.join(", ")}): the plan is most likely not open to the own booking page's reservation source${sourceId ? ` (${sourceId})` : ""}.`,
    ...plans.map(rateSourceFixLine),
    `Until then every online booking on ${plans.length === 1 ? "that plan" : "those plans"} is refused (nothing is charged). To sell the base rate instead meanwhile, set ${[
      ...(kinds.has("auto") ? ["BOOKING_AUTO_DISCOUNTS=off"] : []),
      ...(kinds.has("direct") ? ["BOOKING_DIRECT_PROMO=off"] : []),
    ].join(" and ")} in Vercel and redeploy.${kinds.has("direct") && input.promo?.generic ? " BOOKING_DIRECT_PROMO=off switches off every code on the own page, DIRECT included." : ""}`,
    ...(promoSent && kinds.has("auto") ? [promoLine("If the automatic plan is already open to the source: ", "an automatic discount's rate", "that plan")] : []),
  ];
}

/**
 * postReservation failed. A refusal for availability -> "unavailable". A
 * refusal for anything else, or an auth/4xx error -> alert + "message us"
 * (it would hit every booking). An UNCLEAR outcome (timeout, 5xx, success
 * without an id) -> alert; the intent stays open so the sweeper finds and
 * releases a reservation Cloudbeds may have created anyway.
 */
export async function holdFailed(
  e: unknown,
  input: StripeCheckoutInput,
  deps: CoreDeps,
  ref: string,
  settleIntent: () => Promise<unknown>,
): Promise<StripeCheckoutResult> {
  const err = e instanceof CloudbedsWriteError ? e : null;
  const ambiguous = err ? err.ambiguous : true;
  const message = redactForLog(err?.message ?? (e instanceof Error ? e.message : String(e)));
  deps.log("hold_failed", { ref, kind: err?.kind ?? "unknown", ambiguous, status: err?.status ?? null, requestId: err?.requestId ?? null, message });
  if (!ambiguous) await settleIntent(); // nothing was created

  if (err?.kind === "rejected") {
    // "Sold" only when a FRESH read confirms it; a refusal for a room that is still free is a setup problem.
    let gone: string[] = [];
    let soldNow: boolean;
    if (input.recheckAvailability) {
      try {
        gone = await input.recheckAvailability();
        soldNow = gone.length > 0;
      } catch (re) {
        deps.log("hold_refused_recheck_failed", { ref, error: redactForLog(re instanceof Error ? re.message : String(re)) });
        soldNow = false;
      }
    } else {
      soldNow = isAvailabilityRefusal(err.message);
    }
    if (soldNow) {
      return fail(409, {
        error: "unavailable",
        message: `Sorry - we couldn't reserve this room just now (it may have just been booked). ${NOTHING_CHARGED}`,
        unavailableSlugs: gone.length > 0 ? gone : input.items.map((i) => i.slug),
      });
    }
    await deps.alert(
      "Booking stopped: Cloudbeds refused the reservation",
      [
        `Booking ${ref}: postReservation answered success:false - "${message}"${err.requestId ? ` (request ${err.requestId})` : ""}.`,
        "A fresh availability check still showed the room as free (or could not be made), so this is likely a setup or data problem (a required field, the guestZip placeholder, the rate id, the payment method, the reservation source (CLOUDBEDS_SOURCE_ID), the key's scopes) that will hit every booking. Nothing was charged.",
        ...rateNotForSourceFix(err.message, input, deps.config.cloudbedsSourceId),
      ],
      { key: `hold-refused:${createHash("sha256").update(err.message).digest("hex").slice(0, 12)}`, severity: "warning" },
    );
    return fail(503, { error: "payment_unavailable", message: `We couldn't reserve this room online just now. ${NOTHING_CHARGED} ${MESSAGE_US}` });
  }

  if (ambiguous) {
    await deps.alert(
      "Booking interrupted: Cloudbeds reservation outcome unknown",
      [
        `Booking ${ref}: postReservation failed in a way that may still have created the reservation (${err?.kind ?? "unknown"}${err?.status ? `, HTTP ${err.status}` : ""}${err?.requestId ? `, request ${err.requestId}` : ""}).`,
        `Nothing was charged. If a reservation with third-party id ${ref} exists in Cloudbeds, the sweeper cancels it within about an hour; you can also cancel it by hand.`,
      ],
      { key: `hold-unclear:${err?.kind ?? "unknown"}`, severity: "warning" },
    );
    return fail(502, {
      error: "upstream_error",
      message: `We couldn't get an answer from our reservation system. ${NOTHING_CHARGED} Please try again in a minute - if the room then shows as taken, message us on WhatsApp.`,
    });
  }

  if (err && err.kind !== "budget") {
    await deps.alert(
      "Booking stopped: Cloudbeds error on the reservation",
      [
        `Booking ${ref}: postReservation failed (${err.kind}${err.status ? `, HTTP ${err.status}` : ""}${err.requestId ? `, request ${err.requestId}` : ""}): "${message}".`,
        "Nothing was created or charged. 401/403 means the booking API key or its scopes; 429 means the call budget.",
      ],
      { key: `hold-fail:${err.kind}:${err.status ?? "-"}`, severity: "warning" },
    );
  }
  return fail(503, { error: "payment_unavailable", message: `Our reservation system is busy right now. ${NOTHING_CHARGED} Please try again in a moment, or ${MESSAGE_US.charAt(0).toLowerCase()}${MESSAGE_US.slice(1)}` });
}
