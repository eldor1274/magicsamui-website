// The generic hold-first checkout (Beam design step S1.3): startHoldFirstCheckout reaches the payment provider
// only through the CheckoutAdapter it is given. An "Acme" adapter (provider "beam", the Stripe adapter
// underneath, its page key prefixed "acme:", counting its calls) drives the real core on the in-repo fakes:
// the hold record and the msv:booking:{ref} pointer name the page by its key, the booking token carries its
// paymentId, the hold's note and the log lines follow the adapter, and once the page exists every failure
// closes it (cancelPage) BEFORE the hold is given back. startStripeCheckout itself is pinned by the golden
// snapshot; the last test checks the Stripe adapter's own answers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { getCartInventory } from "./availability.ts";
import { todayInBangkok } from "./dates.ts";
import { startHoldFirstCheckout } from "./holdFirstCheckout.ts";
import type { CheckoutAdapter, CheckoutPageInput, HoldFirstCheckoutContext } from "./holdFirstCheckout.ts";
import { keys, readJson } from "./lock.ts";
import type { BookingPointer, HoldRecord } from "./lock.ts";
import { STRIPE_MAX_CHARGE_SATANG } from "./payments/stripe.ts";
import { stripeCheckoutAdapter } from "./stripeCheckout.ts";
import type { StripeCheckoutInput } from "./stripeCheckout.ts";
import { GUEST, HONEYMOON, ORIGIN, makeKit, request, serverQuote } from "./testkit.ts";
import type { Kit } from "./testkit.ts";
import { verifyBookingToken } from "./token.ts";
import type { CheckoutSuccess } from "./types.ts";

const PREFIX = "acme:";

/** The input runCheckout hands the core: the cart, the test guest, the server's quote and the fresh inventory. */
async function coreInput(kit: Kit): Promise<StripeCheckoutInput> {
  const req = request(HONEYMOON);
  const quote = await serverQuote(kit, req);
  const inv = await getCartInventory(req.checkIn, req.checkOut, req.items, kit.config, { fetchImpl: kit.fakeCb.fetch, allowDemoFallback: false });
  return {
    checkIn: req.checkIn,
    checkOut: req.checkOut,
    items: req.items,
    guest: GUEST,
    quote,
    inventory: inv.inventory,
    dataSource: inv.dataSource,
    today: todayInBangkok(new Date(kit.now.ms)),
  };
}

function coreContext(kit: Kit): HoldFirstCheckoutContext {
  return {
    deps: kit.deps,
    origin: ORIGIN,
    nowMs: kit.now.ms,
    nonce: () => "nonce",
    testAccessToken: kit.checkoutDeps().testAccessToken,
    sleep: async () => undefined,
  };
}

type AcmeInfo = { kind: string };

/** The Stripe adapter under another provider and brand: page key "acme:{session id}", each call recorded. */
function acmeAdapter(kit: Kit, overrides: Partial<CheckoutAdapter<AcmeInfo>> = {}) {
  const inner = stripeCheckoutAdapter(kit.deps, kit.config.stripe!, { origin: ORIGIN, nowMs: kit.now.ms });
  const calls: string[] = [];
  const seen: { input?: CheckoutPageInput } = {};
  const adapter: CheckoutAdapter<AcmeInfo> = {
    provider: "beam",
    brand: "Acme",
    maxChargeSatang: 50_000_000,
    async createPage(input) {
      calls.push(`create ${input.ref}`);
      seen.input = input;
      const page = await inner.createPage(input);
      return { key: `${PREFIX}${page.paymentId}`, paymentId: page.paymentId, redirectUrl: page.redirectUrl };
    },
    isAllowedUrl: (url) => inner.isAllowedUrl(url),
    async cancelPage(key) {
      calls.push(`cancel ${key}`);
      return inner.cancelPage(key.slice(PREFIX.length));
    },
    async afterCreate(page) {
      calls.push(`after ${page.key}`);
    },
    errorInfo: (e) => ({ kind: e instanceof Error ? e.message : "unknown" }),
    pageFailedAlert: (info, ref) => ({ subject: "Booking stopped: Acme could not create the payment page", lines: [`Booking ${ref}: ${info.kind}.`], key: `acme-page-fail:${info.kind}` }),
    ...overrides,
  };
  return { adapter, calls, seen };
}

function onlyReservation(kit: Kit) {
  const all = [...kit.fakeCb.reservations.values()];
  assert.equal(all.length, 1, "exactly one hold");
  return all[0];
}

test("another provider's adapter: page key in the hold record and pointer, paymentId in the token, its brand in the note", async () => {
  const kit = makeKit();
  const input = await coreInput(kit);
  const { adapter, calls, seen } = acmeAdapter(kit);
  // afterCreate runs before the hold record and the pointer name the page.
  const atAfterCreate: { record?: HoldRecord | null; pointer?: BookingPointer | null } = {};
  adapter.afterCreate = async (page) => {
    calls.push(`after ${page.key}`);
    atAfterCreate.record = await readJson<HoldRecord>(kit.deps.kv, keys.hold(seen.input!.reservationId));
    atAfterCreate.pointer = await readJson<BookingPointer>(kit.deps.kv, keys.booking(seen.input!.ref));
  };

  const res = await startHoldFirstCheckout(input, coreContext(kit), adapter);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const body = res.body as CheckoutSuccess;
  const sessionId = new URL(body.redirectUrl).pathname.split("/").pop()!;
  const key = `${PREFIX}${sessionId}`;
  assert.equal(body.provider, "beam");
  assert.ok(kit.fakeStripe.session(sessionId), "the page is the inner adapter's");
  assert.deepEqual(calls, [`create ${body.ref}`, `after ${key}`]);

  // What the adapter was handed.
  const given = seen.input!;
  assert.equal(given.ref, body.ref);
  assert.equal(given.reservationId, body.holdReservationId);
  assert.equal(given.basePath, "/booking-preview");
  assert.equal(given.budgetMs, Number.POSITIVE_INFINITY, "no deadline: an unbounded budget");
  assert.deepEqual(given.guestFlags, { arrivalLate: false, hasRequests: true, noteSaved: true });
  const unpaid = verifyBookingToken(given.token, kit.config.tokenSecret, kit.now.ms);
  assert.ok(unpaid.ok && unpaid.payload.paymentLinkId === null, "the page's own URLs carry a token without a payment id");

  assert.equal(atAfterCreate.record?.sessionId, null);
  assert.equal(atAfterCreate.pointer, null);
  const record = await readJson<HoldRecord>(kit.deps.kv, keys.hold(body.holdReservationId!));
  assert.equal(record?.sessionId, key);
  assert.deepEqual(await readJson<BookingPointer>(kit.deps.kv, keys.booking(body.ref)), { sessionId: key, reservationId: body.holdReservationId });
  const link = verifyBookingToken(body.linkToken, kit.config.tokenSecret, kit.now.ms);
  assert.ok(link.ok && link.payload.paymentLinkId === sessionId, "the link token carries the paymentId, not the key");

  const r = onlyReservation(kit);
  assert.equal(r.status, "not_confirmed");
  assert.ok(r.notes[0].includes(`Online booking ${body.ref} via magicsamui.com (Acme). Awaiting payment`), r.notes[0]);
  assert.doesNotMatch(r.notes.join("\n"), /Stripe/);
  const events = kit.logs.map((l) => l.message);
  assert.ok(events.includes("beam_session_created"));
  assert.ok(!events.some((m) => m.startsWith("stripe_")), events.join(","));
});

test("afterCreate failing: the page is closed by its key, then the hold is cancelled", async () => {
  const kit = makeKit();
  const input = await coreInput(kit);
  const { adapter, calls } = acmeAdapter(kit);
  const statusAtCancel: string[] = [];
  const cancelPage = adapter.cancelPage;
  adapter.cancelPage = async (key) => {
    statusAtCancel.push(onlyReservation(kit).status);
    return cancelPage(key);
  };
  adapter.afterCreate = async (page) => {
    calls.push(`after ${page.key}`);
    throw new Error("payment record not written");
  };

  const res = await startHoldFirstCheckout(input, coreContext(kit), adapter);
  assert.equal(res.status, 502);
  const [created, after, cancelled] = calls;
  assert.match(created, /^create MSV-/);
  const key = after.slice("after ".length);
  assert.equal(cancelled, `cancel ${key}`);
  assert.equal(calls.length, 3);
  assert.equal(kit.fakeStripe.session(key.slice(PREFIX.length))?.status, "expired");
  assert.deepEqual(statusAtCancel, ["not_confirmed"], "the page is closed before the hold is given back");

  const r = onlyReservation(kit);
  assert.equal(r.status, "canceled");
  assert.ok(r.notes.some((n) => n.includes("could not finish starting the payment")));
  assert.ok(kit.logs.some((l) => l.message === "checkout_after_session_failed" && l.data?.sessionId === key));
  const record = await readJson<HoldRecord>(kit.deps.kv, keys.hold(r.reservationID));
  assert.equal(record?.sessionId ?? null, null, "the hold record never named the page");
});

test("a redirect URL the adapter refuses: the page is closed, the hold cancelled, afterCreate never runs", async () => {
  const kit = makeKit();
  const input = await coreInput(kit);
  const { adapter, calls } = acmeAdapter(kit, { isAllowedUrl: () => false });
  const res = await startHoldFirstCheckout(input, coreContext(kit), adapter);
  assert.equal(res.status, 502);
  assert.equal(calls.length, 2);
  assert.match(calls[0], /^create /);
  assert.match(calls[1], new RegExp(`^cancel ${PREFIX}cs_test_`));
  assert.equal(onlyReservation(kit).status, "canceled");
});

test("createPage failing: the adapter's error info and alert, the hold cancelled, no page to close", async () => {
  const kit = makeKit();
  const input = await coreInput(kit);
  const { adapter, calls } = acmeAdapter(kit, {
    async createPage(page) {
      calls.push(`create ${page.ref}`);
      throw new Error("acme down");
    },
  });
  const res = await startHoldFirstCheckout(input, coreContext(kit), adapter);
  assert.equal(res.status, 502);
  assert.equal(calls.length, 1, "nothing to cancel");

  const r = onlyReservation(kit);
  assert.equal(r.status, "canceled");
  assert.ok(r.notes.includes("Hold cancelled by the booking page before any payment: beam session failed. Nothing was charged."), r.notes.join("\n"));
  const failed = kit.logs.find((l) => l.message === "beam_session_failed");
  assert.equal(failed?.data?.kind, "acme down");
  const alert = kit.alerts.find((a) => a.subject === "Booking stopped: Acme could not create the payment page");
  assert.ok(alert, kit.alerts.map((a) => a.subject).join(" | "));
  assert.match(alert.lines[0], /^Booking MSV-\d{8}-[A-Z0-9]{4}: acme down\.$/);
});

test("a crash once the page exists: closed by its key, the alert names the brand and the paymentId", async () => {
  const kit = makeKit();
  const input = await coreInput(kit);
  const { adapter, calls } = acmeAdapter(kit);
  const log = kit.deps.log;
  kit.deps.log = (message, data) => {
    log(message, data);
    if (message === "beam_session_created") throw new Error("simulated crash after the page");
  };
  const res = await startHoldFirstCheckout(input, coreContext(kit), adapter);
  assert.equal(res.status, 500);
  const key = calls[1].slice("after ".length);
  assert.equal(calls[2], `cancel ${key}`);
  assert.equal(onlyReservation(kit).status, "canceled");
  const alert = kit.alerts.find((a) => a.subject === "Booking stopped: unexpected error after the hold");
  assert.ok(alert);
  assert.ok(alert.lines.includes(`The Acme payment page ${key.slice(PREFIX.length)} was expired, the hold was cancelled and nothing was charged.`), alert.lines.join("\n"));
});

test("stripeCheckoutAdapter: provider, brand, maximum charge, hosted-page check and the page-failed alert", () => {
  const kit = makeKit();
  const stripe = kit.config.stripe!;
  const a = stripeCheckoutAdapter(kit.deps, stripe, { origin: ORIGIN, nowMs: kit.now.ms });
  assert.equal(a.provider, "stripe");
  assert.equal(a.brand, "Stripe");
  assert.equal(a.maxChargeSatang, STRIPE_MAX_CHARGE_SATANG);
  assert.equal(a.afterCreate, undefined);
  assert.equal(a.isAllowedUrl("https://checkout.stripe.com/c/pay/cs_test_x"), true);
  assert.equal(a.isAllowedUrl("https://checkout.stripe.com.evil.example/c/pay/cs_test_x"), false);
  assert.equal(a.isAllowedUrl(null), false);
  // stripe-mock's page is on our own origin, and only allowed in mock mode.
  assert.equal(a.isAllowedUrl(`${ORIGIN}/booking-preview/stripe-mock`), false);
  const mock = stripeCheckoutAdapter(kit.deps, { ...stripe, mock: true }, { origin: ORIGIN, nowMs: kit.now.ms });
  assert.equal(mock.isAllowedUrl(`${ORIGIN}/booking-preview/stripe-mock`), true);

  const info = a.errorInfo(new Error("boom"));
  assert.deepEqual(info, { type: "Error", code: null, requestId: null, statusCode: null });
  assert.deepEqual(a.pageFailedAlert({ type: "api_error", code: "x_code", requestId: "req_1", statusCode: 500 }, "MSV-20261005-ABCD"), {
    subject: "Booking stopped: Stripe could not create the payment page",
    lines: [
      "Booking MSV-20261005-ABCD: Stripe refused or failed to create the Checkout Session (api_error, code x_code, HTTP 500, request req_1).",
      "The hold was cancelled and nothing was charged. If this repeats, every online booking is failing: check the restricted key's permissions, the payment methods (PromptPay) and the account status in the Stripe Dashboard.",
    ],
    key: "stripe-session-fail:x_code",
  });
});
