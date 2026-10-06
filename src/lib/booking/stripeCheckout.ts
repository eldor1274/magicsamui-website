// Hold-first Stripe checkout (WI-5 server side). Runs after checkout.ts has
// validated the cart and re-quoted it from Cloudbeds with no cache:
//
//   test-mode guard -> open-holds brake -> hold INTENT recorded (before any
//   Cloudbeds write) -> lock every physical unit in the cart -> refuse a cart
//   that overlaps one of OUR open holds (units + dates in Redis) ->
//   restrictions + availability re-checked under the lock (no cache) ->
//   postReservation (the HOLD: exact roomTypeID + priced roomRateID, guest
//   details, thirdPartyIdentifier = MSV ref (+ -TEST outside live),
//   sendEmailConfirmation=false) -> hold record (units + dates) -> unlock ->
//   assert Cloudbeds grandTotal == our room subtotal (else cancel +
//   price_changed) -> status "not_confirmed" -> Stripe Checkout Session ->
//   redirect.
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

import { createHash } from "node:crypto";
import { getCatalogueRoom } from "./catalogue.ts";
import { CloudbedsWriteError, redactForLog } from "./cloudbedsWrite.ts";
import { MERCHANT_NAME, PAYMENT_LINK_TTL_MINUTES, TOKEN_TTL_HOURS } from "./config.ts";
import { addMonths, compareIso } from "./dates.ts";
import { releaseHold } from "./fulfil.ts";
import { cloudbedsArrivalTime, internationalPhone } from "./guest.ts";
import type { GuestDetails } from "./guest.ts";
import type { KvStore } from "./kv.ts";
import { acquireLock, closeIntent, holdIdentifier, keyScope, keys, readJson, recordHold, recordIntent, releaseLock, writeJson } from "./lock.ts";
import type { HoldRecord, Lock } from "./lock.ts";
import { buildCheckoutSessionParams, isStripeCheckoutUrl, stripeErrorInfo } from "./payments/stripe.ts";
import type { CheckoutSession } from "./payments/stripe.ts";
import type { StripeDeps } from "./stripeDeps.ts";
import { STALE_HOLD_MS, SWEEP_STALE_ALERT_MS } from "./sweep.ts";
import { hasTestAccess } from "./testAccess.ts";
import { createBookingToken, generateBookingRef, generateNonce } from "./token.ts";
import type { BookingSummary, CartItemInput, CheckoutFailure, CheckoutResponse, DataSource, IsoDate, Quote, RoomInventory, ThemeName } from "./types.ts";
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
/** Time needed for the Stripe call after the hold (else the hold is given back at once). */
export const SESSION_MIN_REMAINING_MS = 4_000;
/** Kept back from the Stripe call for cancelling the hold if it fails. */
export const CANCEL_RESERVE_MS = 2_500;
/** Checkouts refused on Cloudbeds reads within the window before the owner is alerted. */
export const READ_FAILURE_ALERT_COUNT = 3;

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

function fail(status: number, body: Omit<CheckoutFailure, "ok">): StripeCheckoutResult {
  return { status, body: { ok: false, ...body } };
}

const NOTHING_CHARGED = "Nothing has been charged.";
const LIVE_UNCONFIRMED = `We could not confirm live availability. ${NOTHING_CHARGED} Please try again in a moment.`;
const MESSAGE_US = "Message us on WhatsApp and we'll complete the booking for you.";

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
};

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

async function unlockAll(kv: KvStore, locks: Lock[]): Promise<void> {
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
export async function noteCheckoutReadFailure(deps: Pick<StripeDeps, "kv" | "alert" | "log" | "config">, step: string, error: string): Promise<void> {
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

/** Our own open holds, then restrictions + availability fresh from Cloudbeds. Runs under the unit lock. null = clear to hold. */
async function checkBeforeHold(input: StripeCheckoutInput, deps: StripeDeps, nowMs: number): Promise<StripeCheckoutResult | null> {
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
      let r;
      try {
        r = await deps.restrictions(room.cloudbedsRoomTypeId, inv?.rateId ?? null, input.checkIn, input.checkOut, item.adults);
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        deps.log("checkout_restrictions_failed", { slug: item.slug, error });
        await noteCheckoutReadFailure(deps, "getRatePlans", error);
        return fail(503, { error: "payment_unavailable", message: LIVE_UNCONFIRMED });
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
async function checkSweeperFresh(deps: StripeDeps, nowMs: number): Promise<void> {
  if (deps.config.paymentMode !== "stripe-live") return;
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

export async function startStripeCheckout(input: StripeCheckoutInput, ctx: StripeCheckoutContext): Promise<StripeCheckoutResult> {
  const { nowMs } = ctx;
  const clock = ctx.clock ?? Date.now;
  // Every Cloudbeds call on this path fits the route's time limit: the budget wait, the fetch timeout and
  // 429 retries are cut to the time left, so a hold can never still be in flight when the platform stops us.
  const deps: StripeDeps =
    ctx.deadlineMs !== undefined && ctx.deps.writer.bounded ? { ...ctx.deps, writer: ctx.deps.writer.bounded(ctx.deadlineMs, clock) } : ctx.deps;
  const { config } = deps;
  const { quote } = input;
  const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  /** Time left before the route must answer (Infinity without a deadline). */
  const remaining = () => (ctx.deadlineMs === undefined ? Number.POSITIVE_INFINITY : ctx.deadlineMs - clock());
  if (!config.stripe) return fail(503, { error: "payment_unavailable", message: `Online payment is not available right now. ${NOTHING_CHARGED}` });

  // Never charge real money at simulated prices; never write a real hold priced from demo data.
  if (deps.writer.mode === "live" && input.dataSource !== "cloudbeds") {
    deps.log("checkout_refused_data_source", { mode: config.paymentMode, dataSource: input.dataSource });
    return fail(503, { error: "payment_unavailable", message: LIVE_UNCONFIRMED });
  }

  // 1. Test-mode guard (Cloudbeds has no sandbox: test holds block real OTA inventory).
  const access = hasTestAccess(config.testGuard?.accessKey ?? null, config.tokenSecret, ctx.testAccessToken);
  const refusal = testModeRefusal(config.testGuard, input.checkIn, input.guest.email, input.today, access);
  if (refusal) {
    deps.log("checkout_test_guard_refused", { access, configured: Boolean(config.testGuard?.guestEmail && config.testGuard?.accessKey) });
    return fail(403, { error: "test_mode_restricted", message: refusal });
  }

  const rooms = input.items.map((item) => {
    const room = getCatalogueRoom(item.slug);
    const inv = input.inventory.find((i) => i.slug === item.slug);
    return { roomTypeId: room?.cloudbedsRoomTypeId ?? "", rateId: inv?.rateId ?? null, adults: item.adults };
  });
  if (rooms.some((r) => r.roomTypeId === "")) return fail(409, { error: "unavailable", message: "A room in your reservation can't be booked online." });

  await checkSweeperFresh(deps, nowMs);

  // 2. Brake on open holds (each one blocks real OTA inventory for up to ~40 minutes).
  try {
    const open = await deps.kv.zrangeByScore(keys.holdIndex(), nowMs - STALE_HOLD_MS, nowMs + 3_600_000, MAX_OPEN_HOLDS + 1);
    if (open.length >= MAX_OPEN_HOLDS) {
      deps.log("checkout_refused_open_holds", { open: open.length });
      await deps.alert(
        "Online bookings paused: too many unpaid holds",
        [`${open.length} unpaid holds are open at once, so new online bookings are refused until some are paid or released (abuse brake).`],
        { key: "too-many-holds", severity: "warning" },
      );
      return fail(503, {
        error: "payment_unavailable",
        message: `We're handling several bookings at once right now. ${NOTHING_CHARGED} Please try again in a few minutes.`,
      });
    }
  } catch (e) {
    deps.log("checkout_kv_failed", { step: "open_holds", error: redactForLog(e instanceof Error ? e.message : String(e)) });
    return fail(503, { error: "payment_unavailable", message: `We couldn't start your booking safely just now. ${NOTHING_CHARGED} Please try again in a moment.` });
  }

  // 3. A fresh ref (refs are short: never reuse one already pointing at a session or attempt).
  let ref = generateBookingRef(input.today, ctx.pickRefChar);
  for (let i = 0; i < 5 && ((await deps.kv.get(keys.booking(ref))) !== null || (await deps.kv.get(keys.intent(ref))) !== null); i++) {
    ref = generateBookingRef(input.today, ctx.pickRefChar);
  }
  const identifier = holdIdentifier(ref, config.paymentMode);

  // 4. Intent BEFORE any Cloudbeds write: whatever happens next, the sweeper can find this attempt.
  try {
    await recordIntent(deps.kv, { ref, identifier, mode: config.paymentMode, createdAt: nowMs, reservationId: null });
  } catch (e) {
    deps.log("checkout_kv_failed", { step: "intent", ref, error: redactForLog(e instanceof Error ? e.message : String(e)) });
    return fail(503, { error: "payment_unavailable", message: `We couldn't start your booking safely just now. ${NOTHING_CHARGED} Please try again in a moment.` });
  }
  const settleIntent = () => closeIntent(deps.kv, ref).catch((e) => deps.log("intent_close_failed", { ref, error: e instanceof Error ? e.message : String(e) }));

  // 5. Our own checkouts never race each other for a unit: lock, re-check fresh, hold, unlock.
  const locks = await lockUnits(deps.kv, cartUnits(input.items), ctx.unitLockWaitMs ?? UNIT_LOCK_WAIT_MS, sleep).catch(() => null);
  if (!locks) {
    await settleIntent();
    deps.log("checkout_unit_busy", { ref });
    return fail(503, {
      error: "upstream_error",
      message: `Someone is completing a booking for this room right now. ${NOTHING_CHARGED} Please try again in a minute.`,
    });
  }
  const units = cartUnits(input.items);
  let hold;
  let recordError: unknown = null;
  try {
    const blocked = await checkBeforeHold(input, deps, nowMs);
    if (blocked) {
      await settleIntent();
      return blocked;
    }
    if (ctx.clientIp) {
      // Per guest (IP + email): a shared IP (hotel Wi-Fi, carrier NAT) never locks other guests out;
      // per IP with a higher cap: one connection can't cycle through made-up emails.
      const brakeWindow = STALE_HOLD_MS / 1000;
      const guestKey = clientKeyOf(config.tokenSecret, `${ctx.clientIp}|${input.guest.email.trim().toLowerCase()}`);
      const perGuest = await deps.kv.incr(keys.clientHolds(guestKey), brakeWindow).catch(() => 0);
      const perIp = await deps.kv.incr(keys.clientHolds(clientKeyOf(config.tokenSecret, ctx.clientIp)), brakeWindow).catch(() => 0);
      if (perGuest > MAX_HOLDS_PER_CLIENT || perIp > MAX_HOLDS_PER_IP) {
        await settleIntent();
        deps.log("checkout_refused_client_holds", { ref, perGuest, perIp });
        return fail(429, {
          error: "rate_limited",
          message: `You've started several bookings in a short time, so online payment is paused for this connection for up to ${CLIENT_BRAKE_MINUTES} minutes. ${NOTHING_CHARGED}`,
          retryAfterMinutes: CLIENT_BRAKE_MINUTES,
        });
      }
    }
    // Never start a hold we may not have time to finish (or give back) before the platform stops the function.
    if (remaining() < HOLD_MIN_REMAINING_MS) {
      await settleIntent();
      deps.log("checkout_out_of_time", { ref, step: "before_hold", remainingMs: Math.round(remaining()) });
      return fail(503, { error: "payment_unavailable", message: `Our reservation system is slow right now. ${NOTHING_CHARGED} Please try again in a moment.` });
    }
    try {
      hold = await deps.writer.createHold({
        ref,
        identifier,
        checkIn: input.checkIn,
        checkOut: input.checkOut,
        rooms,
        guest: {
          firstName: input.guest.firstName,
          lastName: input.guest.lastName,
          email: input.guest.email,
          phone: internationalPhone(input.guest),
          country: input.guest.country,
          zip: (input.guest.postcode ?? "").trim() || config.guestZipPlaceholder,
        },
        estimatedArrivalTime: cloudbedsArrivalTime(input.guest.arrivalTime),
        paymentMethod: config.reservationPaymentMethod,
        expectedRoomsSatang: quote.roomsSubtotalSatang,
      });
    } catch (e) {
      return await holdFailed(e, input, deps, ref, settleIntent);
    }
    // Recorded BEFORE the unit lock is released: the next checkout's overlap check must see it.
    try {
      await recordHold(deps.kv, {
        ref,
        reservationId: hold.reservationId,
        sessionId: null,
        createdAt: nowMs,
        mode: config.paymentMode,
        pendingMarked: hold.status === "not_confirmed",
        units,
        checkIn: input.checkIn,
        checkOut: input.checkOut,
      });
    } catch (e) {
      recordError = e;
    }
  } finally {
    await unlockAll(deps.kv, locks);
  }

  const reservationId = hold.reservationId;
  let pendingMarked = hold.status === "not_confirmed";
  const holdBase = { ref, reservationId, createdAt: nowMs, mode: config.paymentMode, units, checkIn: input.checkIn, checkOut: input.checkOut };
  const cancelHold = async (why: string) => {
    try {
      // Only ever called before the guest has a payment page (or after its session was expired): nobody can have paid.
      await releaseHold(reservationId, deps, why, { neverPayable: true });
    } catch (e) {
      deps.log("hold_cancel_failed", { ref, reservationId, error: redactForLog(e instanceof Error ? e.message : String(e)) });
      await deps.alert(
        `Hold ${reservationId} could not be cancelled`,
        [`Booking ${ref} stopped before payment (${why}) and cancelling Cloudbeds reservation ${reservationId} failed. The sweeper will retry; please check it.`],
        { key: `cancel-fail:${reservationId}`, severity: "warning" },
      );
    }
  };

  if (recordError !== null) {
    // Without a record nothing would track this hold: give it back now (the intent stays for the sweeper if this fails too).
    deps.log("hold_record_failed", { ref, reservationId, error: redactForLog(recordError instanceof Error ? recordError.message : String(recordError)) });
    await cancelHold("could not record the hold");
    return fail(503, { error: "payment_unavailable", message: `We couldn't start your booking safely just now. ${NOTHING_CHARGED} Please try again in a moment.` });
  }
  await settleIntent(); // the open-holds index tracks it from here
  deps.log("hold_created", { ref, reservationId, status: hold.status, mode: config.paymentMode });

  // 6. Price assertion: Cloudbeds prices the reservation itself; we only ever charge what it holds.
  let holdTotal = hold.grandTotalSatang;
  if (holdTotal === null) {
    // A usable id without a readable total: read it back once; never charge on a total we haven't seen.
    holdTotal = await deps.writer
      .getReservation(reservationId)
      .then((r) => r.grandTotalSatang)
      .catch(() => null);
  }
  if (holdTotal === null) {
    deps.log("hold_total_unreadable", { ref, reservationId });
    await cancelHold("hold total unreadable");
    await deps.alert(
      "Booking stopped: Cloudbeds returned no price for the hold",
      [
        `Booking ${ref}: Cloudbeds created reservation ${reservationId} but its total could not be read (postReservation and getReservation). The hold was cancelled and nothing was charged.`,
        "If this repeats, every online booking is failing: check the booking API key's scopes (read:reservation) and the Cloudbeds API status.",
      ],
      { key: "hold-total-unreadable", severity: "warning" },
    );
    return fail(502, { error: "upstream_error", message: `We couldn't get an answer from our reservation system. ${NOTHING_CHARGED} Please try again in a minute.` });
  }
  if (holdTotal !== quote.roomsSubtotalSatang) {
    deps.log("hold_price_mismatch", { ref, reservationId, cloudbeds: holdTotal, quoted: quote.roomsSubtotalSatang });
    await cancelHold("price mismatch");
    await deps.alert(
      "Booking stopped: Cloudbeds price differs from the quote",
      [
        `Booking ${ref} (${input.checkIn} to ${input.checkOut}): Cloudbeds priced the hold at ${holdTotal} satang, the page quoted ${quote.roomsSubtotalSatang} satang for the rooms.`,
        "The hold was cancelled and nothing was charged. A repeat of this means taxes/fees or a rate plan in Cloudbeds differ from what getAvailableRoomTypes returns (WI-0).",
      ],
      { key: `price-mismatch:${input.items.map((i) => i.slug).join(",")}:${input.checkIn}`, severity: "warning" },
    );
    return fail(409, {
      error: "price_changed",
      message: `The price for your stay has just changed in our reservation system. ${NOTHING_CHARGED} Please search again, or message us on WhatsApp and we'll book it for you.`,
    });
  }

  // 7. Mark it "Confirmation pending" so staff never mistake an unpaid hold for a booking (best effort).
  // Both are best effort: skipped when the Stripe call would otherwise run out of time.
  if (!pendingMarked && remaining() >= SESSION_MIN_REMAINING_MS + CANCEL_RESERVE_MS + 4_000) {
    try {
      await deps.writer.markPending(reservationId);
      pendingMarked = true;
    } catch (e) {
      deps.log("hold_mark_pending_failed", { ref, reservationId, error: e instanceof Error ? e.message : String(e) });
    }
  }
  const testLabel = config.paymentMode === "stripe-live" ? "" : "TEST MODE - NOT REAL MONEY. ";
  const noteParts = [
    `${testLabel}Online booking ${ref} via magicsamui.com (Stripe). Awaiting payment - the hold is cancelled automatically if unpaid after ${PAYMENT_LINK_TTL_MINUTES} minutes.`,
    input.guest.arrivalTime === "late" ? "Estimated arrival: after midnight." : "",
    input.guest.specialRequests.trim() ? `Guest requests: ${input.guest.specialRequests.trim()}` : "",
  ].filter(Boolean);
  if (remaining() >= SESSION_MIN_REMAINING_MS + CANCEL_RESERVE_MS + 4_000) {
    await deps.writer.addNote(reservationId, noteParts.join("\n")).catch((e) =>
      deps.log("hold_note_failed", { ref, reservationId, error: e instanceof Error ? e.message : String(e) }),
    );
  } else {
    deps.log("hold_note_skipped_time", { ref, reservationId });
  }

  // 8. Stripe Checkout Session.
  const booking: BookingSummary = {
    ref,
    paymentMode: config.paymentMode,
    checkIn: quote.checkIn,
    checkOut: quote.checkOut,
    nights: quote.nights,
    items: input.items,
    itemRoomSatang: quote.lines.map((l) => l.roomSatang),
    promoCode: null,
    totalSatang: quote.totalSatang,
    cardFeeSatang: quote.cardFeeSatang,
    dueNowSatang: quote.dueNowSatang,
    createdAt: new Date(nowMs).toISOString(),
    linkExpiresAt: new Date(nowMs + PAYMENT_LINK_TTL_MINUTES * 60_000).toISOString(),
    ...(input.theme ? { theme: input.theme } : {}),
  };
  const ttl = TOKEN_TTL_HOURS * 3600;
  const token = createBookingToken(booking, null, config.tokenSecret, ttl, nowMs);
  const basePath = config.bookingEngine === "own" ? "/booking" : "/booking-preview";

  // The Stripe call gets what is left (minus time to give the hold back if it fails).
  const stripeBudgetMs = remaining() - CANCEL_RESERVE_MS;
  if (stripeBudgetMs < SESSION_MIN_REMAINING_MS) {
    deps.log("checkout_out_of_time", { ref, reservationId, step: "before_session", remainingMs: Math.round(remaining()) });
    await cancelHold("out of time before the payment page");
    return fail(503, { error: "payment_unavailable", message: `Our systems are slow right now. ${NOTHING_CHARGED} Please try again in a moment.` });
  }
  const stripeRequestOptions = Number.isFinite(stripeBudgetMs)
    ? { timeout: Math.min(15_000, Math.floor(stripeBudgetMs)), maxNetworkRetries: stripeBudgetMs > 20_000 ? 1 : 0 }
    : {};

  let session: CheckoutSession;
  try {
    const params = buildCheckoutSessionParams({
      ref,
      reservationId,
      quote,
      customerEmail: input.guest.email,
      successUrl: stripeReturnUrl(ctx.origin, basePath, ref, token, input.theme),
      cancelUrl: stripeCancelUrl(ctx.origin, basePath, ref, token, input.theme),
      nowMs,
      ttlMinutes: PAYMENT_LINK_TTL_MINUTES,
      allowedPaymentMethodTypes: config.stripe.allowedPaymentMethodTypes,
      merchantName: MERCHANT_NAME,
      mode: config.paymentMode,
    });
    session = await deps.stripe.checkout.sessions.create(params, {
      idempotencyKey: stripeIdempotencyKey(ref, config.paymentMode, (ctx.nonce ?? generateNonce)()),
      ...stripeRequestOptions,
    });
  } catch (e) {
    const info = stripeErrorInfo(e);
    deps.log("stripe_session_failed", { ref, reservationId, ...info, message: redactForLog(e instanceof Error ? e.message : String(e)) });
    await cancelHold("stripe session failed");
    // A persistent Stripe-side problem (key permission, PromptPay not activated, account restricted) breaks EVERY booking.
    await deps.alert(
      "Booking stopped: Stripe could not create the payment page",
      [
        `Booking ${ref}: Stripe refused or failed to create the Checkout Session (${info.type}${info.code ? `, code ${info.code}` : ""}${info.statusCode ? `, HTTP ${info.statusCode}` : ""}${info.requestId ? `, request ${info.requestId}` : ""}).`,
        "The hold was cancelled and nothing was charged. If this repeats, every online booking is failing: check the restricted key's permissions, the payment methods (PromptPay) and the account status in the Stripe Dashboard.",
      ],
      { key: `stripe-session-fail:${info.code ?? info.type}`, severity: "warning" },
    );
    return fail(502, { error: "upstream_error", message: `We couldn't reach our payment provider. ${NOTHING_CHARGED} Please try again in a moment.` });
  }

  // Anything failing from here leaves an OPEN session: expire it (so it can never be paid) and release the hold.
  try {
    if (!isStripeCheckoutUrl(session.url, config.stripe.mock ? ctx.origin : null)) throw new Error("Unexpected Checkout URL host");
    await recordHold(deps.kv, { ...holdBase, sessionId: session.id, pendingMarked });
    await writeJson(deps.kv, keys.booking(ref), { sessionId: session.id, reservationId }, ttl);
    if ((await deps.kv.get(keys.releaseDone(reservationId))) !== null) throw new Error("the hold was released meanwhile");
  } catch (e) {
    deps.log("checkout_after_session_failed", { ref, reservationId, sessionId: session.id, error: redactForLog(e instanceof Error ? e.message : String(e)) });
    await deps.stripe.checkout.sessions
      .expire(session.id)
      .catch((x) => deps.log("stripe_session_expire_failed", { ref, sessionId: session.id, error: redactForLog(x instanceof Error ? x.message : String(x)) }));
    await cancelHold("could not finish starting the payment");
    return fail(502, { error: "upstream_error", message: `Something went wrong while starting your payment. ${NOTHING_CHARGED} Please try again in a moment.` });
  }

  const linkToken = createBookingToken(booking, session.id, config.tokenSecret, ttl, nowMs);
  deps.log("stripe_session_created", { ref, reservationId, sessionId: session.id, amount: quote.dueNowSatang, mode: config.paymentMode });

  return {
    status: 200,
    body: {
      ok: true,
      ref,
      redirectUrl: session.url as string,
      paymentMode: config.paymentMode,
      dataSource: input.dataSource,
      quote,
      expiresAt: booking.linkExpiresAt,
      linkToken,
      provider: "stripe",
      holdReservationId: reservationId,
    },
  };
}

/**
 * postReservation failed. A refusal for availability -> "unavailable". A
 * refusal for anything else, or an auth/4xx error -> alert + "message us"
 * (it would hit every booking). An UNCLEAR outcome (timeout, 5xx, success
 * without an id) -> alert; the intent stays open so the sweeper finds and
 * releases a reservation Cloudbeds may have created anyway.
 */
async function holdFailed(
  e: unknown,
  input: StripeCheckoutInput,
  deps: StripeDeps,
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
        "A fresh availability check still showed the room as free (or could not be made), so this is likely a setup or data problem (a required field, the guestZip placeholder, the rate id, the payment method, the key's scopes) that will hit every booking. Nothing was charged.",
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
