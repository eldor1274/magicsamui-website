// The hold-first checkout, whatever provider takes the money (WI-5 server side; Beam design step S1.3).
// Runs after checkout.ts has validated the cart and re-quoted it from Cloudbeds with no cache, and keeps the
// chain stripeCheckout.ts describes:
//
//   payment-method refusal -> test-mode guard -> sweeper freshness -> open-holds brake -> fresh ref and
//   hold INTENT -> unit locks -> checkBeforeHold -> client brakes -> time budget -> postReservation (the
//   HOLD) -> hold record -> unlock -> folio assert -> "not_confirmed" -> guest note -> the provider's
//   payment page -> hold record and pointer name it -> redirect.
//
// Only the payment page belongs to the provider. Its CheckoutAdapter creates the page within the time that
// is left, checks the page's URL, closes it again (cancelPage) and words the owner's alert when it can't be
// created. The page's key names the payment in Redis (the hold record and the msv:booking:{ref} pointer);
// its paymentId goes into the booking token. Once the page exists, any failure closes it and then gives the
// hold back, and so does the crash catch. startStripeCheckout (stripeCheckout.ts) is this core with the
// Stripe adapter.
//
// The shared constants and helpers are in checkoutShared.ts, which this file and stripeCheckout.ts both
// import: stripeCheckout.ts imports this file for startStripeCheckout, and nothing here imports it back.

import { getCatalogueRoom } from "./catalogue.ts";
import { CloudbedsWriteError, redactForLog } from "./cloudbedsWrite.ts";
import type { ReservationInfo } from "./cloudbedsWrite.ts";
import { PAYMENT_LINK_TTL_MINUTES, TOKEN_TTL_HOURS } from "./config.ts";
import { releaseHold } from "./fulfil.ts";
import { cloudbedsArrivalTime, internationalPhone } from "./guest.ts";
import type { GuestDetails } from "./guest.ts";
import { closeIntent, holdIdentifier, keys, recordHold, recordIntent, writeJson } from "./lock.ts";
import { isLiveMode } from "./payments/provider.ts";
import { bookingItemDiscount, satangToBahtString } from "./quote.ts";
import {
  AUTO_AT_BASE_ALERT_PREFIX,
  CANCEL_RESERVE_MS,
  CLIENT_BRAKE_MINUTES,
  CODE_AT_BASE_FIX,
  DIRECT_AT_BASE_ALERT,
  FOLIO_CHECK_MIN_REMAINING_MS,
  FOLIO_RETRY_PAUSE_MS,
  HOLD_MIN_REMAINING_MS,
  LIVE_UNCONFIRMED,
  MAX_HOLDS_PER_CLIENT,
  MAX_HOLDS_PER_IP,
  MAX_OPEN_HOLDS,
  MESSAGE_US,
  NOTHING_CHARGED,
  SESSION_MIN_REMAINING_MS,
  UNIT_LOCK_WAIT_MS,
  autoAtBaseAlert,
  autoAtBaseMessage,
  cartUnits,
  checkBeforeHold,
  checkSweeperFresh,
  classifyHoldTotal,
  clientKeyOf,
  codeAtBaseAlertOf,
  codePlansText,
  codeRateNames,
  directAtBaseMessage,
  fail,
  holdFailed,
  lockUnits,
  testModeRefusal,
  unlockAll,
} from "./checkoutShared.ts";
import type { StripeCheckoutContext, StripeCheckoutInput, StripeCheckoutResult } from "./checkoutShared.ts";
import type { CoreDeps } from "./stripeDeps.ts";
import { STALE_HOLD_MS } from "./sweep.ts";
import { hasTestAccess } from "./testAccess.ts";
import { createBookingToken, generateBookingRef, generateNonce } from "./token.ts";
import type { BookingSummary, PaymentProvider, Quote } from "./types.ts";

/** StripeCheckoutContext with provider-free deps: the core reaches the provider only through its adapter. */
export type HoldFirstCheckoutContext = Omit<StripeCheckoutContext, "deps"> & { deps: CoreDeps };

/** What the core hands the adapter to create the payment page (after the hold, its price check and the note). */
export interface CheckoutPageInput {
  ref: string;
  reservationId: string;
  quote: Quote;
  guest: GuestDetails;
  booking: BookingSummary;
  /** The booking token without a payment id, for the return and cancel URLs. */
  token: string;
  /** "/booking" (own engine) or "/booking-preview". */
  basePath: string;
  /** Yes/no flags for fulfilment (never the request text); noteSaved = the hold's note reached Cloudbeds. */
  guestFlags: { arrivalLate: boolean; hasRequests: boolean; noteSaved: boolean };
  /** Time the provider call may take: what is left minus CANCEL_RESERVE_MS (Infinity without a deadline). */
  budgetMs: number;
  /** Salt of the provider's idempotency key (one draw per attempt; tests pin it). */
  nonce: () => string;
}

export interface CheckoutPage {
  /** Names the payment in Redis: the hold record's and the pointer's sessionId (Stripe: the session id). */
  key: string;
  /** The provider's own id, carried by the booking token (Stripe: the session id). */
  paymentId: string;
  /** The hosted page; the guest is sent there only once isAllowedUrl accepts it. */
  redirectUrl: string | null;
}

/** The provider side of the hold-first checkout (stripeCheckoutAdapter in stripeCheckout.ts). */
export interface CheckoutAdapter<Info extends object = object> {
  provider: Exclude<PaymentProvider, "demo">;
  /** The provider's name in the hold's Cloudbeds note and the owner's alerts ("Stripe"). */
  brand: string;
  /** The largest single charge the provider takes. runCheckout refuses a larger stay before anything is held. */
  maxChargeSatang: number;
  /** Creates the payment page within input.budgetMs. A throw cancels the hold and alerts (pageFailedAlert). */
  createPage(input: CheckoutPageInput): Promise<CheckoutPage>;
  /** True when the URL is the provider's hosted page (the guest is never sent anywhere else). */
  isAllowedUrl(url: string | null): boolean;
  /** Makes the page unpayable (Stripe: expires the session). A failure is logged and the hold is given back anyway. */
  cancelPage(key: string): Promise<unknown>;
  /** Runs once the page exists, before the hold record names it (Beam writes its payment record here). A throw closes the page and cancels the hold. */
  afterCreate?(page: CheckoutPage): Promise<void>;
  /** What the log line and the alert say about a failed createPage (no personal data). */
  errorInfo(e: unknown): Info;
  /** The owner's alert (warning) when createPage failed; the hold is already cancelled. */
  pageFailedAlert(info: Info, ref: string): { subject: string; lines: string[]; key: string };
}

export async function startHoldFirstCheckout<Info extends object>(
  input: StripeCheckoutInput,
  ctx: HoldFirstCheckoutContext,
  adapter: CheckoutAdapter<Info>,
): Promise<StripeCheckoutResult> {
  const { nowMs } = ctx;
  const clock = ctx.clock ?? Date.now;
  // Every Cloudbeds call on this path fits the route's time limit: the budget wait, the fetch timeout and
  // 429 retries are cut to the time left, so a hold can never still be in flight when the platform stops us.
  const deps: CoreDeps =
    ctx.deadlineMs !== undefined && ctx.deps.writer.bounded ? { ...ctx.deps, writer: ctx.deps.writer.bounded(ctx.deadlineMs, clock) } : ctx.deps;
  const { config } = deps;
  const { quote } = input;
  const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  /** Time left before the route must answer (Infinity without a deadline). */
  const remaining = () => (ctx.deadlineMs === undefined ? Number.POSITIVE_INFINITY : ctx.deadlineMs - clock());

  // Never charge real money at simulated prices; never write a real hold priced from demo data.
  if (deps.writer.mode === "live" && input.dataSource !== "cloudbeds") {
    deps.log("checkout_refused_data_source", { mode: config.paymentMode, dataSource: input.dataSource });
    return fail(503, { error: "payment_unavailable", message: LIVE_UNCONFIRMED });
  }

  // Without a usable Cloudbeds payment method EVERY paid booking would stay unconfirmed: refuse before anything is held.
  if (deps.writer.mode === "live" && config.cloudbedsPaymentMethodProblem) {
    deps.log("checkout_refused_payment_method", { mode: config.paymentMode });
    await deps.alert(
      "Online bookings stopped: the Cloudbeds payment method is not set up",
      [
        config.cloudbedsPaymentMethodProblem,
        "Every online checkout is refused before anything is reserved or charged until this is fixed; guests are asked to message us on WhatsApp.",
      ],
      { key: "payment-method-config", severity: "warning" },
    );
    return fail(503, { error: "payment_unavailable", message: `Online payment is not available right now. ${NOTHING_CHARGED} ${MESSAGE_US}` });
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
  // Rooms the server's re-quote put on the code's Cloudbeds rate (never anything the browser sent); an automatic
  // discount is held on its roomRateID alone (no code).
  const directRooms = input.promo ? input.items.some((item) => input.inventory.find((i) => i.slug === item.slug)?.discount?.kind === "direct") : false;

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
        sourceId: config.cloudbedsSourceId,
        // A room on the code's roomRateID: Cloudbeds' promo code (its own spelling) goes with it (the price check below proves it was applied).
        promoCode: directRooms ? input.promo?.cloudbedsCode ?? null : null,
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
      // Only ever called before the guest has a payment page (or after the page was closed): nobody can have paid.
      await releaseHold(reservationId, deps, why, { neverPayable: true });
      // The reason stays readable in Cloudbeds (server logs expire). Best effort.
      await deps.writer
        .addNote(reservationId, `Hold cancelled by the booking page before any payment: ${why}. Nothing was charged.`)
        .catch((x) => deps.log("cancel_note_failed", { ref, reservationId, error: redactForLog(x instanceof Error ? x.message : String(x)) }));
    } catch (e) {
      deps.log("hold_cancel_failed", { ref, reservationId, error: redactForLog(e instanceof Error ? e.message : String(e)) });
      await deps.alert(
        `Hold ${reservationId} could not be cancelled`,
        [`Booking ${ref} stopped before payment (${why}) and cancelling Cloudbeds reservation ${reservationId} failed. The sweeper will retry; please check it.`],
        { key: `cancel-fail:${reservationId}`, severity: "warning" },
      );
    }
  };

  // Any unexpected error from here used to leave the hold in Cloudbeds with no cancel and no alert until the
  // sweeper found it 30+ minutes later (2026-10-20). Now: close the payment page if one exists, give the hold
  // back, note it in Cloudbeds, alert the owner.
  let pageForCleanup: CheckoutPage | null = null;
  /** Best effort: a page that can't be closed is logged, and the hold is given back anyway. */
  const closePage = (key: string) =>
    adapter
      .cancelPage(key)
      .catch((x: unknown) => deps.log(`${adapter.provider}_session_expire_failed`, { ref, sessionId: key, error: redactForLog(x instanceof Error ? x.message : String(x)) }));
  try {
    if (recordError !== null) {
      // Without a record nothing would track this hold: give it back now (the intent stays for the sweeper if this fails too).
      deps.log("hold_record_failed", { ref, reservationId, error: redactForLog(recordError instanceof Error ? recordError.message : String(recordError)) });
      await cancelHold("could not record the hold");
      return fail(503, { error: "payment_unavailable", message: `We couldn't start your booking safely just now. ${NOTHING_CHARGED} Please try again in a moment.` });
    }
    await settleIntent(); // the open-holds index tracks it from here
    // Cloudbeds' own creation stamp (no zone) next to our log time calibrates its clock (Stage B).
    deps.log("hold_created", { ref, reservationId, status: hold.status, mode: config.paymentMode, cloudbedsDateCreated: hold.dateCreated });

    // 6. Price assertion: Cloudbeds prices the reservation itself; we only ever charge what it holds. The folio is
    // ALWAYS read back before the payment page (a failed read is tried once more when time allows): postReservation's
    // total may leave out taxes/fees that the folio carries (the guest would pay our fee AND be asked for Cloudbeds' at check-in).
    const quoted = quote.roomsSubtotalSatang;
    const timeForFolio = remaining() >= FOLIO_CHECK_MIN_REMAINING_MS;
    let folio: ReservationInfo | null = null;
    if (timeForFolio) {
      // The read must leave time for the payment page's call or a cancel.
      const reader =
        ctx.deadlineMs !== undefined && deps.writer.bounded ? deps.writer.bounded(ctx.deadlineMs - SESSION_MIN_REMAINING_MS - CANCEL_RESERVE_MS, clock) : deps.writer;
      folio = await reader
        .getReservation(reservationId)
        .catch(async (e) => {
          // One blip must not cost a correctly priced hold: a GET is never ambiguous, so read once more when that still fits.
          if (!(e instanceof CloudbedsWriteError) || e.kind === "budget" || remaining() < FOLIO_CHECK_MIN_REMAINING_MS + FOLIO_RETRY_PAUSE_MS) throw e;
          deps.log("hold_folio_read_retry", { ref, reservationId, error: redactForLog(e.message) });
          await sleep(FOLIO_RETRY_PAUSE_MS);
          return reader.getReservation(reservationId);
        })
        .catch((e) => {
          deps.log("hold_folio_read_failed", { ref, reservationId, error: redactForLog(e instanceof Error ? e.message : String(e)) });
          return null;
        });
    }
    const check = classifyHoldTotal({
      quotedRoomsSatang: quoted,
      holdTotalSatang: hold.grandTotalSatang,
      folio,
      baseRoomsSatang: quote.directRate?.baseRoomsSatang ?? null,
      autoBaseRoomsSatang: quote.autoDiscount?.baseRoomsSatang ?? null,
    });
    if (check.kind === "unreadable" && !timeForFolio) {
      deps.log("checkout_out_of_time", { ref, reservationId, step: "before_folio_check", remainingMs: Math.round(remaining()) });
      await cancelHold("out of time before the folio check");
      return fail(503, { error: "payment_unavailable", message: `Our systems are slow right now. ${NOTHING_CHARGED} Please try again in a moment.` });
    }
    if (check.kind === "unreadable") {
      deps.log("hold_total_unreadable", { ref, reservationId });
      await cancelHold("hold total unreadable");
      await deps.alert(
        "Booking stopped: Cloudbeds returned no price for the hold",
        [
          `Booking ${ref}: Cloudbeds created reservation ${reservationId} but its total could not be verified (the folio read back with getReservation was unreadable or failed). The hold was cancelled and nothing was charged.`,
          "If this repeats, every online booking is failing: check the booking API key's scopes (read:reservation) and the Cloudbeds API status.",
        ],
        { key: "hold-total-unreadable", severity: "warning" },
      );
      return fail(502, { error: "upstream_error", message: `We couldn't get an answer from our reservation system. ${NOTHING_CHARGED} Please try again in a minute.` });
    }
    if (check.kind === "cloudbeds_fees") {
      const source = config.cloudbedsSourceId
        ? `CLOUDBEDS_SOURCE_ID ${config.cloudbedsSourceId}`
        : "Website / Booking engine (default; CLOUDBEDS_SOURCE_ID is not set or not a primary source id)";
      const shown = folio?.sourceId ? ` Cloudbeds shows the hold under ${folio.source ?? "source"} ${folio.sourceId}.` : "";
      // A source already configured: the fee is on that source, or Cloudbeds ignored the id's form (s-N vs s-N-1).
      const fix = config.cloudbedsSourceId
        ? `Fix: in Cloudbeds (Settings > Property > Sources; scripts/cloudbeds-wi0-check.mjs section 4b) check that source ${config.cloudbedsSourceId} carries no taxes or fees, and remove any that was added. If it carries none, Cloudbeds probably ignored the id: switch CLOUDBEDS_SOURCE_ID to the other form (s-N or s-N-1, Stage B case 19) and redeploy.`
        : "Fix: in Cloudbeds go to Settings > Property > Sources and add a primary source for the own booking page with NO taxes or fees; put its id (s-<number>) in CLOUDBEDS_SOURCE_ID and redeploy.";
      deps.log("hold_taxes_fees", { ref, reservationId, quoted, extra: check.extraSatang, pct: check.pctOfRooms, sourceId: config.cloudbedsSourceId });
      await cancelHold("Cloudbeds taxes/fees on the hold");
      await deps.alert(
        "Online bookings blocked: Cloudbeds adds taxes/fees to online holds",
        [
          `Booking ${ref} (${input.checkIn} to ${input.checkOut}): Cloudbeds added THB ${satangToBahtString(check.extraSatang)} of taxes/fees (${check.pctOfRooms}% of the rooms) on top of the THB ${satangToBahtString(quoted)} the page quoted for the rooms. The hold was cancelled and nothing was charged; the guest was asked to message us on WhatsApp. Every online booking is refused this way until it is fixed.`,
          `Reservation source used: ${source}.${shown}`,
          `${fix} Never remove the Card Charging Fee from the "Website / Booking Engine" source while the classic booking engine uses it.`,
        ],
        // One alert per mode (the alerter scopes keys by mode), not per room and date: it hits every booking.
        { key: "hold-taxes-fees", severity: "warning" },
      );
      return fail(503, { error: "payment_unavailable", message: `We couldn't reserve this room online just now. ${NOTHING_CHARGED} ${MESSAGE_US}` });
    }
    if (check.kind === "promo_at_base") {
      const at = codeAtBaseAlertOf(input, quote);
      const code = at.code;
      if (input.promo?.generic) {
        // A code other than DIRECT: its own log line and alert (one per code), naming the code, its plans and the switch.
        deps.log("hold_code_at_base", { ref, reservationId, quoted, cloudbeds: check.totalSatang, code, plans: at.plans });
        await cancelHold(`Cloudbeds priced code ${code}'s rate at the base rate`);
        await deps.alert(
          at.subject,
          [
            `Booking ${ref} (${input.checkIn} to ${input.checkOut}): the page quoted THB ${satangToBahtString(quoted)} for the rooms on ${codePlansText(at.plans)} (code ${code}; Cloudbeds promo code ${input.promo.cloudbedsCode}), but Cloudbeds priced the hold at THB ${satangToBahtString(check.totalSatang)}, exactly the base rate. The hold was cancelled and nothing was charged; the guest was offered the classic booking page (where Cloudbeds applies the code) and WhatsApp. Every online booking with the code is refused this way until this is fixed.`,
            CODE_AT_BASE_FIX,
          ],
          // One alert per code and mode (the alerter scopes keys by mode), not per booking: it hits every booking with the code.
          { key: at.key, severity: "warning" },
        );
        return fail(503, { error: "payment_unavailable", message: directAtBaseMessage(code, at.plans) });
      }
      deps.log("hold_direct_at_base", { ref, reservationId, quoted, cloudbeds: check.totalSatang });
      await cancelHold("Cloudbeds priced the Direct rate at the base rate");
      await deps.alert(
        DIRECT_AT_BASE_ALERT,
        [
          `Booking ${ref} (${input.checkIn} to ${input.checkOut}): the page quoted THB ${satangToBahtString(quoted)} for the rooms on the Direct rate (code ${code}; Cloudbeds promo code ${input.promo?.cloudbedsCode ?? "-"}), but Cloudbeds priced the hold at THB ${satangToBahtString(check.totalSatang)}, exactly the base rate. The hold was cancelled and nothing was charged; the guest was offered the classic booking page (where Cloudbeds applies the code) and WhatsApp. Every online booking with the code is refused this way until this is fixed.`,
          "Fix now: set BOOKING_DIRECT_PROMO=off in Vercel and redeploy. Guests who enter the code on the own page are then sent to /booking/classic, and bookings without the code are not affected. Then ask Cloudbeds support how postReservation applies a promo rate (rooms[0][roomRateID] + promoCode) before switching it back on.",
        ],
        // One alert per mode (the alerter scopes keys by mode), not per booking: it hits every booking with the code.
        { key: "direct-at-base", severity: "warning" },
      );
      return fail(503, { error: "payment_unavailable", message: directAtBaseMessage(code) });
    }
    if (check.kind === "auto_at_base") {
      const names = quote.autoDiscount?.names ?? [];
      const plan = names.length > 0 ? names.join(" and ") : "the automatic discount";
      deps.log("hold_auto_discount_at_base", { ref, reservationId, quoted, cloudbeds: check.totalSatang, plans: names, alsoDirect: check.alsoDirect });
      await cancelHold("Cloudbeds priced the automatic discount at the base rate");
      await deps.alert(
        autoAtBaseAlert(plan),
        [
          `Booking ${ref} (${input.checkIn} to ${input.checkOut}): the page quoted THB ${satangToBahtString(quoted)} for the rooms with ${plan} applied automatically (no code), but Cloudbeds priced the hold at THB ${satangToBahtString(check.totalSatang)}, exactly the base rate for ${check.alsoDirect ? "those rooms and the Direct-rate rooms" : "those rooms"}. The hold was cancelled and nothing was charged; the guest was offered the classic booking page and WhatsApp. Every online booking on that plan is refused this way until this is fixed.`,
          "Fix now: set BOOKING_AUTO_DISCOUNTS=off in Vercel and redeploy. The own page then sells the base rate without the automatic discounts (the Direct rate for the code is not affected). Then ask Cloudbeds support how postReservation applies a derived rate sent as rooms[0][roomRateID] without a promo code before switching it back on.",
        ],
        // One alert per mode (the alerter scopes keys by mode), not per booking or plan: it hits every booking on the plan.
        { key: "auto-discount-at-base", severity: "warning" },
      );
      const at = codeAtBaseAlertOf(input, quote);
      if (check.alsoDirect) {
        await deps.alert(
          at.subject,
          [
            `Booking ${ref} (${input.checkIn} to ${input.checkOut}): Cloudbeds priced the ${input.promo?.generic ? `code ${at.code}` : "Direct-rate"} rooms of a cart that also had automatic discounts at the base rate as well (see "${AUTO_AT_BASE_ALERT_PREFIX} ..."). The hold was cancelled and nothing was charged.`,
            `If bookings with the code alone are refused the same way, set BOOKING_DIRECT_PROMO=off in Vercel and redeploy${input.promo?.generic ? " (it switches off every code, DIRECT included)" : ""}.`,
          ],
          { key: at.key, severity: "warning" },
        );
      }
      return fail(503, { error: "payment_unavailable", message: check.alsoDirect ? directAtBaseMessage(at.code, at.plans) : autoAtBaseMessage(names) });
    }
    if (check.kind === "price_changed") {
      deps.log("hold_price_mismatch", { ref, reservationId, cloudbeds: check.totalSatang, quoted, pct: check.pctOfQuote });
      await cancelHold("price mismatch");
      await deps.alert(
        "Booking stopped: Cloudbeds price differs from the quote",
        [
          `Booking ${ref} (${input.checkIn} to ${input.checkOut}): Cloudbeds priced the hold at ${check.totalSatang} satang (${check.pctOfQuote}% against the quote), the page quoted ${quoted} satang for the rooms.`,
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
    // Both are best effort: skipped when the payment page's call would otherwise run out of time.
    if (!pendingMarked && remaining() >= SESSION_MIN_REMAINING_MS + CANCEL_RESERVE_MS + 4_000) {
      try {
        await deps.writer.markPending(reservationId);
        pendingMarked = true;
      } catch (e) {
        deps.log("hold_mark_pending_failed", { ref, reservationId, error: e instanceof Error ? e.message : String(e) });
      }
    }
    const testLabel = isLiveMode(config.paymentMode) ? "" : "TEST MODE - NOT REAL MONEY. ";
    // "After 11 PM" (estimatedArrivalTime null) and the guest's requests reach Cloudbeds ONLY through this note.
    const guestFlags = { arrivalLate: input.guest.arrivalTime === "late", hasRequests: input.guest.specialRequests.trim() !== "", noteSaved: false };
    const noteParts = [
      `${testLabel}Online booking ${ref} via magicsamui.com (${adapter.brand}). Awaiting payment - the hold is cancelled automatically if unpaid after ${PAYMENT_LINK_TTL_MINUTES} minutes.`,
      guestFlags.arrivalLate ? "Estimated arrival: after 11 PM." : "",
      // The promo-code rate: "Direct rate (code DIRECT)." / "Long term (code LONGSTAY)."
      quote.directRate ? `${codeRateNames(quote).join(", ") || "Direct rate"} (code ${quote.directRate.code}).` : "",
      quote.autoDiscount ? `Automatic discount: ${quote.autoDiscount.names.join(", ")}.` : "",
      guestFlags.hasRequests ? `Guest requests: ${input.guest.specialRequests.trim()}` : "",
    ].filter(Boolean);
    if (remaining() >= SESSION_MIN_REMAINING_MS + CANCEL_RESERVE_MS + 4_000) {
      // Best effort; whether it was saved goes into the payment's metadata (guestFlags), so fulfil can flag a PAID booking that lacks it.
      guestFlags.noteSaved = await deps.writer.addNote(reservationId, noteParts.join("\n")).then(
        () => true,
        (e) => {
          deps.log("hold_note_failed", { ref, reservationId, error: e instanceof Error ? e.message : String(e) });
          return false;
        },
      );
    } else {
      deps.log("hold_note_skipped_time", { ref, reservationId });
    }

    // 8. The provider's payment page.
    const booking: BookingSummary = {
      ref,
      paymentMode: config.paymentMode,
      checkIn: quote.checkIn,
      checkOut: quote.checkOut,
      nights: quote.nights,
      items: input.items,
      itemRoomSatang: quote.lines.map((l) => l.roomSatang),
      // The discounted rate of each room (the return page shows it with the base price struck through).
      ...(quote.lines.some((l) => l.listRoomSatang !== undefined) ? { itemDiscounts: quote.lines.map((l) => bookingItemDiscount(l, quote)) } : {}),
      // The guest's code when the Direct rate was booked (return page and GA4 purchase `coupon`).
      promoCode: quote.directRate?.code ?? null,
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

    // The provider call gets what is left (minus time to give the hold back if it fails).
    const budgetMs = remaining() - CANCEL_RESERVE_MS;
    if (budgetMs < SESSION_MIN_REMAINING_MS) {
      deps.log("checkout_out_of_time", { ref, reservationId, step: "before_session", remainingMs: Math.round(remaining()) });
      await cancelHold("out of time before the payment page");
      return fail(503, { error: "payment_unavailable", message: `Our systems are slow right now. ${NOTHING_CHARGED} Please try again in a moment.` });
    }

    let page: CheckoutPage;
    try {
      page = await adapter.createPage({
        ref,
        reservationId,
        quote,
        guest: input.guest,
        booking,
        token,
        basePath,
        guestFlags,
        budgetMs,
        nonce: ctx.nonce ?? generateNonce,
      });
    } catch (e) {
      const info = adapter.errorInfo(e);
      deps.log(`${adapter.provider}_session_failed`, { ref, reservationId, ...info, message: redactForLog(e instanceof Error ? e.message : String(e)) });
      await cancelHold(`${adapter.provider} session failed`);
      // A persistent provider-side problem (key permission, a payment method not activated, account restricted) breaks EVERY booking.
      const failed = adapter.pageFailedAlert(info, ref);
      await deps.alert(failed.subject, failed.lines, { key: failed.key, severity: "warning" });
      return fail(502, { error: "upstream_error", message: `We couldn't reach our payment provider. ${NOTHING_CHARGED} Please try again in a moment.` });
    }

    pageForCleanup = page;
    // Anything failing from here leaves an OPEN page: close it (so it can never be paid) and release the hold.
    try {
      if (!adapter.isAllowedUrl(page.redirectUrl)) throw new Error("Unexpected Checkout URL host");
      if (adapter.afterCreate) await adapter.afterCreate(page);
      await recordHold(deps.kv, { ...holdBase, sessionId: page.key, pendingMarked });
      await writeJson(deps.kv, keys.booking(ref), { sessionId: page.key, reservationId }, ttl);
      if ((await deps.kv.get(keys.releaseDone(reservationId))) !== null) throw new Error("the hold was released meanwhile");
    } catch (e) {
      deps.log("checkout_after_session_failed", { ref, reservationId, sessionId: page.key, error: redactForLog(e instanceof Error ? e.message : String(e)) });
      await closePage(page.key);
      await cancelHold("could not finish starting the payment");
      return fail(502, { error: "upstream_error", message: `Something went wrong while starting your payment. ${NOTHING_CHARGED} Please try again in a moment.` });
    }

    const linkToken = createBookingToken(booking, page.paymentId, config.tokenSecret, ttl, nowMs);
    deps.log(`${adapter.provider}_session_created`, { ref, reservationId, sessionId: page.key, amount: quote.dueNowSatang, mode: config.paymentMode });

    return {
      status: 200,
      body: {
        ok: true,
        ref,
        redirectUrl: page.redirectUrl as string,
        paymentMode: config.paymentMode,
        dataSource: input.dataSource,
        quote,
        expiresAt: booking.linkExpiresAt,
        linkToken,
        provider: adapter.provider,
        holdReservationId: reservationId,
      },
    };
  } catch (e) {
    const message = redactForLog(e instanceof Error ? e.message : String(e));
    const page = pageForCleanup;
    deps.log("checkout_crashed_after_hold", { ref, reservationId, sessionId: page?.key ?? null, message });
    if (page?.key) await closePage(page.key);
    await cancelHold("unexpected error on our side after the hold");
    await deps.alert(
      "Booking stopped: unexpected error after the hold",
      [
        `Booking ${ref} (Cloudbeds reservation ${reservationId}) failed on our side after the hold was created: ${message}`,
        page?.key
          ? `The ${adapter.brand} payment page ${page.paymentId} was expired, the hold was cancelled and nothing was charged.`
          : "No payment page existed yet; the hold was cancelled and nothing was charged.",
        "If this repeats, online bookings are failing on our side: check the Vercel logs for checkout_crashed_after_hold.",
      ],
      { key: "checkout-crash", severity: "warning" },
    );
    return fail(500, { error: "server_error", message: `Something went wrong on our side. ${NOTHING_CHARGED} Please try again in a moment.` });
  }
}
