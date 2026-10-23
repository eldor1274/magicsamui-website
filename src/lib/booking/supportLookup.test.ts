// The WhatsApp bot's payment lookup (supportLookup.ts, POST /api/support/payment-lookup) and the Beam-only support
// index it reads (payments/beamSupport.ts, written by the Beam checkout adapter). Deterministic: the Beam test kit
// (beamTestkit.ts) on the in-repo fake Beam and fake Cloudbeds, a memory store, the kit's clock; nothing leaves the
// process.
//
// Covered: the bearer secret (unset, short, wrong, missing, in the query string; "unconfigured" logged once per
// instance, rejected tokens counted), no Beam config, the per-IP and global rate limits, the body limits; a lookup by
// ref, phone (however the number is written) and email + ref, and an email alone (a count only, details withheld);
// every state (open, processing, unconfirmed, paid, confirmed, expired, cancelled, refunded, failed, needs_attention,
// unknown); the failureCode words and shape; payAgainSafe (an attempt still settling blocks paying again on the others,
// other bookings' finished attempts never do); an old page Beam has not closed; "don't pay again" while a charge is
// pending; at most 5 attempts, newest first, Beam read for the newest 3 only; the 30-day retention of the index entries;
// the index is Beam only (a Stripe checkout writes none of it, a Stripe ref answers notBeam) and per payment mode; a
// Redis failure, a hanging Redis or a near deadline never breaks a Beam checkout; no personal data in the index, the
// logs or the answers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { BEAM_LIVE_ENV, BEAM_TEST_ENV, beamCheckout, beamHeld, cardDigitsShown, makeBeamKit, makeParityKit } from "./beamTestkit.ts";
import type { BeamKit } from "./beamTestkit.ts";
import { getCatalogueRoom } from "./catalogue.ts";
import { fulfilPayment } from "./fulfil.ts";
import { createMemoryKv } from "./kv.ts";
import type { KvStore } from "./kv.ts";
import { DONE_TTL_SECONDS, beamKeyOf, keyScope, keys } from "./lock.ts";
import { readRecord, writeRecord } from "./payments/beamRecord.ts";
import type { PaymentRecord } from "./payments/beamRecord.ts";
import { BEAM_PENDING_BLOCK_MS } from "./payments/beamState.ts";
import {
  SUPPORT_INDEX_MAX_ENTRIES,
  SUPPORT_INDEX_TTL_SECONDS,
  lookupPhoneDigits,
  normaliseEmail,
  readSupportList,
  readSupportRef,
  supportCode,
  supportEntry,
  supportPhoneForms,
  writeSupportIndex,
} from "./payments/beamSupport.ts";
import {
  BOT_LOOKUP_SECRET_MIN_LENGTH,
  DETAILS_WITHHELD_MESSAGE,
  NOTHING_FOUND_MESSAGE,
  NOT_BEAM_MESSAGE,
  SUPPORT_LOOKUP_BEAM_READS,
  SUPPORT_LOOKUP_GLOBAL_LIMIT,
  SUPPORT_LOOKUP_IP_LIMIT,
  SUPPORT_LOOKUP_MAX_BODY_BYTES,
  failureWords,
  handlePaymentLookup,
  lookupInstanceState,
  parseLookupQuery,
} from "./supportLookup.ts";
import type { FailureOffer, LookupAnswer, LookupMatch, PaymentLookupDeps } from "./supportLookup.ts";
import { FAR_CHECKIN, FAR_CHECKOUT, GUEST, NOW, TOKEN_SECRET, TEST_EMAIL, recordingKv } from "./testkit.ts";
import type { CartItemInput } from "./types.ts";

const SECRET = "bot-lookup-secret-for-the-tests-0123456789";
const ENV = { BOT_LOOKUP_SECRET: SECRET };
const URL_ = "https://magicsamui.com/api/support/payment-lookup";
const GARDEN: CartItemInput[] = [{ slug: "garden-suite", ratePlanId: "standard", adults: 2, addonIds: [] }];
/** GUEST's phone as the booking form sent it: +66 and "95 246 6011". */
const PHONE_DIGITS = "952466011";
const CARD = "1111";
/** The rooms' public names, as the booking page and Beam's page show them. */
const HONEYMOON_NAME = getCatalogueRoom("honeymoon-suite")?.name ?? "";
const GARDEN_NAME = getCatalogueRoom("garden-suite")?.name ?? "";

interface Call {
  status: number;
  body: Record<string, unknown>;
  headers: Headers;
}

function post(body: unknown, opts: { auth?: string | null; ip?: string; contentType?: string; url?: string } = {}): Request {
  const headers: Record<string, string> = { "content-type": opts.contentType ?? "application/json", "x-forwarded-for": opts.ip ?? "203.0.113.7" };
  if (opts.auth !== null) headers.authorization = opts.auth ?? `Bearer ${SECRET}`;
  return new Request(opts.url ?? URL_, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
}

type CallOptions = Parameters<typeof post>[1] & {
  env?: Record<string, string | undefined>;
  deps?: Partial<PaymentLookupDeps>;
  /** Count against the rate limits (the limit tests). Otherwise the kit's counters start afresh for each call. */
  limits?: boolean;
};

async function call(kit: BeamKit | null, body: unknown, opts: CallOptions = {}): Promise<Call> {
  if (kit && !opts.limits) {
    const scope = keyScope(kit.config.paymentMode);
    await kit.deps.kv.del(keys.beamSupportRate(scope, "all"));
    await kit.deps.kv.del(keys.beamSupportRate(scope, `ip:${supportCode(kit.config.tokenSecret, "ip", opts.ip ?? "203.0.113.7")}`));
  }
  const deps: PaymentLookupDeps = { beamDeps: () => kit?.deps ?? null, log: kit ? kit.deps.log : () => undefined, ...opts.deps };
  const res = await handlePaymentLookup(post(body, opts), opts.env ?? ENV, deps);
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, headers: res.headers };
}

async function lookup(kit: BeamKit, body: unknown, opts: CallOptions = {}): Promise<LookupAnswer> {
  const res = await call(kit, body, opts);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.headers.get("cache-control"), "no-store");
  return res.body as unknown as LookupAnswer;
}

async function only(kit: BeamKit, body: unknown): Promise<LookupMatch> {
  const a = await lookup(kit, body);
  assert.equal(a.found, 1, JSON.stringify(a));
  assert.equal(a.matches.length, 1);
  return a.matches[0];
}

/** Everything a guest must never see in an answer, a log line or a stored value. */
function assertNoPii(text: string, label: string): void {
  for (const value of [TEST_EMAIL, TEST_EMAIL.toUpperCase(), PHONE_DIGITS, "95 246 6011", `${GUEST.firstName} ${GUEST.lastName}`, GUEST.lastName, GUEST.specialRequests]) {
    assert.ok(!text.includes(value), `${label}: ${value} must not appear`);
  }
  assert.equal(cardDigitsShown(text, CARD), false, `${label}: no card digits`);
}

const OFFER: FailureOffer = { ewallets: true, promptPay: true, promptPayFree: true };

/* ------------------------------------------------ auth and limits ------------------------------------------------ */

test("the bearer secret: unset or short answers 503 for everything, a wrong or missing one 401; nothing is read first", async () => {
  const kit = makeBeamKit();
  const h = await beamHeld(kit);
  const beamCalls = kit.fakeBeam.calls.length;
  let built = 0;
  const deps = { beamDeps: () => (built++, kit.deps) };
  for (const env of [{}, { BOT_LOOKUP_SECRET: "" }, { BOT_LOOKUP_SECRET: "   " }, { BOT_LOOKUP_SECRET: "x".repeat(BOT_LOOKUP_SECRET_MIN_LENGTH - 1) }]) {
    const res = await call(kit, { ref: h.ref }, { env, deps, auth: `Bearer ${env.BOT_LOOKUP_SECRET ?? ""}` });
    assert.equal(res.status, 503);
    assert.deepEqual(res.body, { ok: false, error: "not_configured", message: "The payment lookup is not configured." });
    assert.equal(res.headers.get("cache-control"), "no-store");
  }
  assert.equal(BOT_LOOKUP_SECRET_MIN_LENGTH, 32);
  assert.ok(kit.logs.some((l) => l.message === "support_lookup_unconfigured" && /shorter than 32/.test(String(l.data?.reason))));
  assert.ok(!kit.logText().includes("x".repeat(BOT_LOOKUP_SECRET_MIN_LENGTH - 1)), "the short secret is never logged");

  for (const auth of [null, "", `Bearer ${SECRET}x`, `Bearer ${SECRET.slice(0, -1)}`, `Basic ${SECRET}`, SECRET, "Bearer "]) {
    const res = await call(kit, { ref: h.ref }, { auth, deps });
    assert.equal(res.status, 401, String(auth));
    assert.deepEqual(res.body, { ok: false, error: "unauthorized", message: "Unauthorized." });
  }
  // Never from the query string.
  const res = await call(kit, { ref: h.ref }, { auth: null, deps, url: `${URL_}?token=${SECRET}&authorization=Bearer%20${SECRET}` });
  assert.equal(res.status, 401);
  assert.equal(built, 0, "no Beam deps built before the token matches");
  assert.equal(kit.fakeBeam.calls.length, beamCalls, "no Beam call");
  // A 32-character secret with spaces around it in Vercel works; the right token answers.
  const ok = await call(kit, { ref: h.ref }, { env: { BOT_LOOKUP_SECRET: ` ${SECRET} ` } });
  assert.equal(ok.status, 200);
});

test("no Beam config on this deployment: 503 beam_unavailable (also when building the deps throws)", async () => {
  const none = await call(null, { email: TEST_EMAIL });
  assert.equal(none.status, 503);
  assert.equal(none.body.error, "beam_unavailable");
  const throws = await call(null, { email: TEST_EMAIL }, { deps: { beamDeps: () => { throw new Error("config"); } } });
  assert.equal(throws.status, 503);
  assert.equal(throws.body.error, "beam_unavailable");
});

test("rate limits: 10 a minute per client IP and 20 in all, 429 with Retry-After; a new minute starts again", async () => {
  const kit = makeBeamKit();
  const limits = true;
  for (let i = 0; i < SUPPORT_LOOKUP_IP_LIMIT; i++) assert.equal((await call(kit, { email: "nobody@example.com" }, { limits })).status, 200);
  const limited = await call(kit, { email: "nobody@example.com" }, { limits });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error, "rate_limited");
  assert.equal(limited.headers.get("retry-after"), "60");
  // Another client still gets answers, until the global limit.
  assert.equal((await call(kit, { email: "nobody@example.com" }, { ip: "198.51.100.1", limits })).status, 200);
  let answered = SUPPORT_LOOKUP_IP_LIMIT + 1;
  for (let i = 2; answered < SUPPORT_LOOKUP_GLOBAL_LIMIT; i++) {
    assert.equal((await call(kit, { email: "nobody@example.com" }, { ip: `198.51.100.${i}`, limits })).status, 200);
    answered++;
  }
  assert.equal((await call(kit, { email: "nobody@example.com" }, { ip: "198.51.100.250", limits })).status, 429, "the global limit");
  kit.now.ms += 61_000;
  assert.equal((await call(kit, { email: "nobody@example.com" }, { limits })).status, 200, "a new window");
  // The counters are keyed by a one-way code of the IP, never the IP itself.
  const scope = keyScope(kit.config.paymentMode);
  assert.ok((await kit.deps.kv.get(keys.beamSupportRate(scope, `ip:${supportCode(TOKEN_SECRET, "ip", "203.0.113.7")}`))) !== null);
  assert.deepEqual([SUPPORT_LOOKUP_IP_LIMIT, SUPPORT_LOOKUP_GLOBAL_LIMIT], [10, 20]);
});

test("a Redis failure in the rate limit answers 503 unavailable (no lookup)", async () => {
  const kit = makeBeamKit({ kv: { ...createMemoryKv(() => NOW), incr: async () => { throw new Error("redis down"); } } as KvStore });
  const res = await call(kit, { email: TEST_EMAIL });
  assert.equal(res.status, 503);
  assert.equal(res.body.error, "unavailable");
});

test("the body: JSON only (415), at most 2 KB (413), exactly one of ref, email or phone, or email and ref together (400)", async () => {
  const kit = makeBeamKit();
  assert.equal((await call(kit, "ref=MSV-20261005-ABCD", { contentType: "application/x-www-form-urlencoded" })).status, 415);
  assert.equal((await call(kit, { email: `${"a".repeat(SUPPORT_LOOKUP_MAX_BODY_BYTES)}@example.com` })).status, 413);
  assert.equal((await call(kit, "{not json")).status, 400);
  for (const body of [
    {},
    [],
    "null",
    { ref: "MSV-20261005-ABCD", phone: "+66 95 246 6011" },
    { email: TEST_EMAIL, phone: "+66 95 246 6011" },
    { ref: "MSV-20261005-ABCD", email: TEST_EMAIL, phone: "+66 95 246 6011" },
    { ref: "MSV-2026-ABCD", email: TEST_EMAIL },
    { ref: "MSV-20261005-ABCD", email: "not-an-email" },
    { ref: "MSV-20261005-ABCD", email: TEST_EMAIL, name: "Test Owner" },
    { name: "Test Owner" },
    { ref: "MSV-2026-ABCD" },
    { ref: "MSV-20261005-ABC0" },
    { email: "not-an-email" },
    { email: 42 },
    { phone: "12345" },
    { phone: "+66 95 246 6011 ext 2" },
  ]) {
    const res = await call(kit, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.error, "invalid_request");
  }
  assert.deepEqual(parseLookupQuery({ ref: " msv-20261005-abcd " }), { kind: "ref", value: "MSV-20261005-ABCD" });
  assert.deepEqual(parseLookupQuery({ email: "  Guest.Name@Example.COM " }), { kind: "email", value: "guest.name@example.com" });
  assert.deepEqual(parseLookupQuery({ phone: "095-246-6011", email: "" }), { kind: "phone", value: "66952466011" });
  assert.deepEqual(parseLookupQuery({ ref: "msv-20261005-abcd", email: " Guest@Example.com" }), { kind: "email_ref", value: "guest@example.com", ref: "MSV-20261005-ABCD" });
  assert.equal(parseLookupQuery(JSON.parse('{"__proto__": "MSV-20261005-ABCD"}')), null);
});

/* ------------------------------------------------ normalising ------------------------------------------------ */

test("phone numbers: the lookup's form and the forms a guest's number is indexed under always meet", () => {
  for (const raw of ["+66 95 246 6011", "+66952466011", "66952466011", "0952466011", "095 246 6011", "0066 95 246 6011", "+66 095 246 6011", "(095) 246-6011"]) {
    assert.equal(lookupPhoneDigits(raw), "66952466011", raw);
  }
  for (const raw of ["", "12345", "+", "abc", "952466011x", "+1234567890123456", 66952466011]) assert.equal(lookupPhoneDigits(raw), null, String(raw));
  // Thai guests: the trunk 0 typed or not.
  assert.deepEqual(supportPhoneForms("+66", "95 246 6011"), ["66952466011"]);
  assert.deepEqual(supportPhoneForms("+66", "095 246 6011"), ["66952466011"]);
  assert.deepEqual(supportPhoneForms("+66", "66 95 246 6011"), ["6666952466011", "66952466011"]);
  // Other countries: as typed and without the trunk 0 (WhatsApp's form), so either lookup finds it.
  const uk = supportPhoneForms("+44", "07700 900123");
  assert.deepEqual(uk, ["4407700900123", "447700900123"]);
  assert.ok(uk.includes(lookupPhoneDigits("+44 7700 900123") as string));
  assert.ok(uk.includes(lookupPhoneDigits("+44 07700 900123") as string));
  // Typed internationally in the number field ("0049 ..."): the number alone is indexed too (as typed with +49 it has 16 digits).
  assert.deepEqual(supportPhoneForms("+49", "0049 151 2345678"), ["49491512345678", "491512345678"]);
  assert.deepEqual(supportPhoneForms("", "123"), []);
  assert.equal(normaliseEmail(" A.B@Example.com "), "a.b@example.com");
  assert.equal(normaliseEmail("no-at-sign"), null);
  // The one-way code: keyed, per kind, 43 characters.
  const code = supportCode(TOKEN_SECRET, "email", "a.b@example.com");
  assert.match(code, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(code, supportCode("another-secret", "email", "a.b@example.com"));
  assert.notEqual(code, supportCode(TOKEN_SECRET, "phone", "a.b@example.com"));
  assert.throws(() => supportCode("", "email", "a.b@example.com"), RangeError);
});

/* ------------------------------------------------ finding attempts ------------------------------------------------ */

test("a fresh Beam checkout is found by ref, phone (however written) and email + ref: the open page, nothing personal", async () => {
  const kit = makeBeamKit();
  const h = await beamHeld(kit);
  const queries = [
    { ref: h.ref },
    { ref: h.ref.toLowerCase() },
    { email: TEST_EMAIL, ref: h.ref },
    { email: ` ${TEST_EMAIL.toUpperCase()} `, ref: h.ref.toLowerCase() },
    { phone: "+66 95 246 6011" },
    { phone: "0952466011" },
    { phone: "66952466011" },
    { phone: "+66 095 246 6011" },
  ];
  for (const q of queries) {
    const m = await only(kit, q);
    assert.deepEqual(
      m,
      {
        ref: h.ref,
        createdAt: new Date(NOW).toISOString(),
        checkIn: FAR_CHECKIN,
        checkOut: FAR_CHECKOUT,
        units: [HONEYMOON_NAME],
        totalSatang: h.quote.dueNowSatang,
        total: m.total,
        currency: "THB",
        payMethod: "card_ewallet",
        state: "open",
        failureCode: null,
        reason: "Your payment page is still open and nothing has been charged yet.",
        nextStep: "You can still pay on the same payment page (it closes 30 minutes after it was opened), or make a new booking on magicsamui.com/booking.",
        cloudbedsConfirmed: false,
        retrySafe: true,
        paymentPageOpen: true,
      },
      JSON.stringify(q),
    );
    assert.match(m.total ?? "", /^\d{1,3}(,\d{3})*\.\d{2}$/);
    assertNoPii(JSON.stringify(m), JSON.stringify(q));
  }
  // Another guest's details find nothing, and say no more than that.
  for (const q of [{ email: "someone-else@example.com" }, { phone: "+66 81 111 2222" }, { ref: "MSV-20261005-ZZZZ" }]) {
    const a = await lookup(kit, q);
    assert.deepEqual(a, { ok: true, lookup: Object.keys(q)[0], found: 0, matches: [], payAgainSafe: true, message: NOTHING_FOUND_MESSAGE, checkedAt: new Date(NOW).toISOString() });
  }
  assertNoPii(kit.logText(), "logs");
  assert.ok(kit.logs.some((l) => l.message === "support_lookup" && l.data?.by === "phone" && l.data?.found === 1));
});

test("the ref still works once the 48-hour pointer is gone (the support index's ref entry), and without the index (the pointer)", async () => {
  const kit = makeBeamKit();
  const h = await beamHeld(kit);
  await kit.deps.kv.del(keys.booking(h.ref));
  assert.equal((await only(kit, { ref: h.ref })).state, "open");
  const scope = keyScope(kit.config.paymentMode);
  await kit.deps.kv.del(keys.beamSupportRef(scope, h.ref));
  assert.equal((await lookup(kit, { ref: h.ref })).found, 0);
  // A booking made before the index existed: the pointer only, the rooms from the link's order items.
  const old = await beamHeld(kit, "card_ewallet", GARDEN);
  await kit.deps.kv.del(keys.beamSupportRef(scope, old.ref));
  const m = await only(kit, { ref: old.ref });
  assert.equal(m.state, "open");
  assert.deepEqual(m.units, [GARDEN_NAME]);
});

test("at most 5 attempts, newest first; one guest's attempts with two rooms both listed", async () => {
  const kit = makeBeamKit();
  const first = await beamHeld(kit);
  kit.now.ms += 60_000;
  const second = await beamHeld(kit, "promptpay", GARDEN);
  const a = await lookup(kit, { email: TEST_EMAIL, ref: first.ref });
  assert.equal(a.lookup, "email_ref");
  assert.deepEqual(a.matches.map((m) => [m.ref, m.payMethod, m.units]), [
    [second.ref, "promptpay", [GARDEN_NAME]],
    [first.ref, "card_ewallet", [HONEYMOON_NAME]],
  ]);
  // Twelve attempts in the index (ten kept), five answered, newest first.
  const scope = keyScope(kit.config.paymentMode);
  const code = supportCode(TOKEN_SECRET, "phone", "447700900123");
  const emailCode = supportCode(TOKEN_SECRET, "email", "many@example.com");
  const refs: string[] = [];
  for (let i = 0; i < 12; i++) {
    const entry = supportEntry(`MSV-20261005-AB${"CDEFGHJKLMNP"[i]}${"CDEFGHJKLMNP"[i]}`, `Lnk${String(i).padStart(7, "0")}`, NOW + i * 1000, ["honeymoon-suite"]);
    assert.ok(entry);
    refs.push(entry.ref);
    await writeSupportIndex(kit.deps.kv, { mode: kit.config.paymentMode, entry, emailCode, phoneCodes: [code] });
  }
  const list = await readSupportList(kit.deps.kv, keys.beamSupportContact(scope, "phone", code), NOW + 12_000);
  assert.equal(list.length, SUPPORT_INDEX_MAX_ENTRIES);
  assert.deepEqual(list.map((e) => e.at), Array.from({ length: 10 }, (_, i) => NOW + (11 - i) * 1000));
  const beamReads = kit.fakeBeam.count(/^GET \/api\/v1\/payment-links\//);
  const many = await lookup(kit, { phone: "+44 7700 900123" });
  assert.equal(many.found, 5);
  // Links Beam does not know (and no record of ours): answered, but nothing promised; Beam read for the newest 3 only.
  assert.deepEqual(many.matches.map((m) => [m.createdAt, m.state, m.retrySafe]), Array.from({ length: 5 }, (_, i) => [new Date(NOW + (11 - i) * 1000).toISOString(), "unknown", false]));
  assert.equal(kit.fakeBeam.count(/^GET \/api\/v1\/payment-links\//) - beamReads, SUPPORT_LOOKUP_BEAM_READS);
  assert.equal(many.payAgainSafe, false);
  // Email + ref: the email's five newest, or the four newest and the ref when it is older than those.
  const byEmail = await lookup(kit, { email: "many@example.com", ref: refs[3] });
  assert.deepEqual(byEmail.matches.map((m) => m.ref), [refs[11], refs[10], refs[9], refs[8], refs[3]]);
  // An email alone: the count, capped at 5, nothing more.
  assert.equal((await lookup(kit, { email: "many@example.com" })).found, 5);
});

/* ------------------------------------------------ the states ------------------------------------------------ */

test("processing: a charge waiting for the bank or wallet - don't pay again (retrySafe false)", async () => {
  const kit = makeBeamKit();
  const h = await beamHeld(kit, "promptpay");
  kit.fakeBeam.payPending(h.linkId, "QR_PROMPT_PAY");
  const m = await only(kit, { ref: h.ref });
  assert.equal(m.state, "processing");
  assert.equal(m.retrySafe, false);
  assert.equal(m.payMethod, "promptpay");
  assert.equal(m.paymentPageOpen, true);
  assert.match(m.nextStep, /^Please don't pay again\./);
  // The window is over, the bank has still not answered (inside 24 hours): still "don't pay again", the hold released.
  kit.fakeBeam.expire(h.linkId);
  kit.now.ms += 21 * 60_000;
  const late = await only(kit, { ref: h.ref });
  assert.equal(late.state, "processing");
  assert.equal(late.retrySafe, false);
  assert.equal(late.paymentPageOpen, false);
  assert.equal(late.reason, "Your bank or wallet hasn't confirmed this payment yet, and the payment window has ended.");
  assert.match(late.nextStep, /^Please don't pay again\./);
  // A pending charge that never settled in 24 hours: expired, booking again is safe.
  kit.now.ms += 24 * 3_600_000;
  const dead = await only(kit, { ref: h.ref });
  assert.equal(dead.state, "expired");
  assert.equal(dead.retrySafe, true);
});

test("paid (being confirmed), then confirmed from the done marker with no Beam call", async () => {
  const kit = makeBeamKit();
  const h = await beamHeld(kit);
  kit.fakeBeam.pay(h.linkId, "CARD");
  const paid = await only(kit, { phone: "+66952466011" });
  assert.equal(paid.state, "paid");
  assert.equal(paid.retrySafe, false);
  assert.equal(paid.cloudbedsConfirmed, false);
  assert.equal(paid.paymentPageOpen, false);
  assert.match(paid.nextStep, /^Please don't pay again\./);
  const outcome = await fulfilPayment(h.key, kit.deps, kit.gw);
  assert.equal(outcome.state, "confirmed");
  const calls = kit.fakeBeam.calls.length;
  const done = await only(kit, { email: TEST_EMAIL, ref: h.ref });
  assert.equal(kit.fakeBeam.calls.length, calls, "a finished booking needs no Beam call");
  assert.equal(done.state, "confirmed");
  assert.equal(done.cloudbedsConfirmed, true);
  assert.equal(done.retrySafe, false);
  assert.equal(done.reason, "Your payment was received and your booking is confirmed.");
  assert.deepEqual([done.checkIn, done.checkOut, done.totalSatang, done.units], [FAR_CHECKIN, FAR_CHECKOUT, h.quote.dueNowSatang, [HONEYMOON_NAME]]);
  assertNoPii(JSON.stringify(done) + kit.logText(), "confirmed");
});

test("expired, and cancelled on the payment page: nothing charged, booking again is safe", async () => {
  const kit = makeBeamKit();
  const h = await beamHeld(kit);
  kit.fakeBeam.expire(h.linkId);
  const m = await only(kit, { ref: h.ref });
  assert.equal(m.state, "expired");
  assert.equal(m.retrySafe, true);
  assert.equal(m.paymentPageOpen, false);
  assert.match(m.reason, /^The 30-minute payment window ended/);
  await kit.deps.kv.set(keys.abandoned(h.key), "1", DONE_TTL_SECONDS);
  const c = await only(kit, { ref: h.ref });
  assert.equal(c.state, "expired");
  assert.equal(c.reason, "The payment page was cancelled, so nothing was charged and the room hold was released.");
});

test("read-only: a lookup writes only its rate counters - no Beam write, no Cloudbeds call, no alert, no payment marker", async () => {
  const kv = recordingKv(createMemoryKv(() => NOW));
  const kit = makeBeamKit({ kv });
  const states: string[] = [];
  const expireMe = await beamHeld(kit, "card_ewallet", GARDEN);
  kit.fakeBeam.expire(expireMe.linkId);
  const payMe = await beamHeld(kit);
  kit.fakeBeam.pay(payMe.linkId, "CARD");
  const at = { kv: kv.writes.length, beam: kit.fakeBeam.calls.length, cb: kit.fakeCb.calls.length, alerts: kit.alerts.length };
  for (const q of [{ email: TEST_EMAIL, ref: expireMe.ref }, { phone: "0952466011" }, { ref: payMe.ref }, { ref: expireMe.ref }, { email: TEST_EMAIL }]) {
    for (const m of (await lookup(kit, q, { limits: true })).matches) states.push(m.state);
  }
  assert.deepEqual(states, ["paid", "expired", "paid", "expired", "paid", "expired"]);
  const writes = kv.writes.slice(at.kv);
  assert.ok(writes.length > 0 && writes.every((w) => w.op === "incr" && w.key.includes(":beam:support:rate:")), JSON.stringify(writes));
  assert.deepEqual(kit.fakeBeam.calls.slice(at.beam).filter((c) => c.method !== "GET"), [], "Beam is only read");
  assert.equal(kit.fakeCb.calls.length, at.cb, "no Cloudbeds call");
  assert.equal(kit.alerts.length, at.alerts, "no alert");
  assert.equal(await kv.get(keys.fulfilDone(payMe.key)), null, "the paid booking is not fulfilled from here");
  assert.equal(await kv.get(keys.beamPrimary(payMe.linkId)), null, "not even the gateway's primary-charge marker");
});

test("an ACTIVE link past its expiry (Beam has not closed it yet) is never offered as open: don't use the old page, not retrySafe until it closes", async () => {
  const kit = makeBeamKit({ beam: { expiryLagMs: Number.POSITIVE_INFINITY } });
  const h = await beamHeld(kit);
  const failed = await beamHeld(kit, "card_ewallet", GARDEN);
  kit.fakeBeam.decline(failed.linkId, "CARD", "CH_CARD_DECLINED");
  kit.now.ms += 33 * 60_000;
  assert.equal(kit.fakeBeam.link(h.linkId).status, "ACTIVE");
  const m = await only(kit, { ref: h.ref });
  assert.equal(m.state, "expired");
  assert.equal(m.paymentPageOpen, false);
  assert.equal(m.retrySafe, false, "the old page may still take a payment");
  assert.equal(m.nextStep, "You're welcome to book again on magicsamui.com/booking. Please don't use the old payment page.");
  const f = await only(kit, { ref: failed.ref });
  assert.equal(f.state, "failed");
  assert.equal(f.retrySafe, false);
  assert.match(f.nextStep, /please make a new booking on magicsamui\.com\/booking\. Please don't use the old payment page\.$/);
  // The lookup only reads: the link is not disabled from here (the sweeper does that).
  assert.equal(kit.fakeBeam.count(/^PATCH /), 0);
  assert.equal(kit.fakeBeam.link(h.linkId).status, "ACTIVE");
  // Once Beam reads it DISABLED (the sweeper) or EXPIRED: booking again is safe, no warning about the old page.
  kit.fakeBeam.disable(h.linkId);
  const closed = await only(kit, { ref: h.ref });
  assert.deepEqual([closed.state, closed.retrySafe, closed.nextStep], ["expired", true, "You're welcome to book again on magicsamui.com/booking."]);
  kit.fakeBeam.expire(failed.linkId);
  const closedFailed = await only(kit, { ref: failed.ref });
  assert.deepEqual([closedFailed.state, closedFailed.retrySafe], ["failed", true]);
  assert.doesNotMatch(closedFailed.nextStep, /old payment page/);
});

test("refunded: read from Beam, and from the done marker of a booking refunded before it was confirmed", async () => {
  const kit = makeBeamKit();
  const h = await beamHeld(kit);
  const charge = kit.fakeBeam.pay(h.linkId, "CARD");
  kit.fakeBeam.refund(charge.chargeId);
  const m = await only(kit, { ref: h.ref });
  assert.equal(m.state, "refunded");
  assert.equal(m.retrySafe, false);
  await kit.deps.kv.set(keys.fulfilDone(h.key), JSON.stringify({ state: "needs_attention", reservationId: h.reservationId, ref: h.ref, totalSatang: h.quote.dueNowSatang, refunded: true, at: NOW }), DONE_TTL_SECONDS);
  const calls = kit.fakeBeam.calls.length;
  assert.equal((await only(kit, { ref: h.ref })).state, "refunded");
  assert.equal(kit.fakeBeam.calls.length, calls);
});

test("failed: the latest charge's failureCode in plain words, the next step for an open and a closed page", async () => {
  const kit = makeBeamKit();
  const h = await beamHeld(kit);
  kit.fakeBeam.decline(h.linkId, "CARD", "CH_CARD_DECLINED");
  kit.now.ms += 1_000;
  kit.fakeBeam.decline(h.linkId, "CARD", "CH_INSUFFICIENT_FUNDS");
  const m = await only(kit, { email: TEST_EMAIL, ref: h.ref });
  assert.equal(m.state, "failed");
  assert.equal(m.failureCode, "CH_INSUFFICIENT_FUNDS", "the latest attempt's code");
  assert.equal(m.reason, "Your bank declined the payment for insufficient funds.");
  assert.equal(
    m.nextStep,
    "Try another card or an e-wallet. You can also choose Thai PromptPay QR (no fee) when you book again. Your payment page is still open for a short while, so you can try again there right away.",
  );
  assert.equal(m.retrySafe, true);
  assert.equal(m.paymentPageOpen, true);
  kit.fakeBeam.expire(h.linkId);
  const closed = await only(kit, { email: TEST_EMAIL, ref: h.ref });
  assert.equal(closed.state, "failed");
  assert.equal(closed.paymentPageOpen, false);
  assert.match(closed.nextStep, /The room hold has been released, so please make a new booking on magicsamui\.com\/booking\.$/);
  assertNoPii(JSON.stringify(closed), "failed");
  // A later attempt that is pending wins over the failed one: don't pay again.
  const k2 = makeBeamKit();
  const h2 = await beamHeld(k2);
  k2.fakeBeam.decline(h2.linkId, "CARD", "CH_CARD_DECLINED");
  k2.now.ms += 1_000;
  k2.fakeBeam.payPending(h2.linkId, "LINE_PAY");
  const pending = await only(k2, { ref: h2.ref });
  assert.equal(pending.state, "processing");
  assert.equal(pending.failureCode, null);
  assert.equal(pending.retrySafe, false);
});

test("needs_attention: a payment that disagrees with our record, a payment after the hold was released, fulfil's marker", async () => {
  const kit = makeBeamKit();
  const wrong = await beamHeld(kit);
  kit.fakeBeam.pay(wrong.linkId, "CARD", { amount: 100 });
  const m = await only(kit, { ref: wrong.ref });
  assert.equal(m.state, "needs_attention");
  assert.equal(m.retrySafe, false);
  assert.equal(m.reason, "Your payment needs a quick manual check by our team.");

  const late = await beamHeld(kit, "card_ewallet", GARDEN);
  await kit.deps.kv.set(keys.releaseDone(late.reservationId), "1", DONE_TTL_SECONDS);
  kit.fakeBeam.pay(late.linkId, "CARD");
  const l = await only(kit, { ref: late.ref });
  assert.equal(l.state, "needs_attention");
  assert.equal(l.reason, "Your payment arrived after the room hold had ended, so our team needs to check your booking by hand.");
  assert.match(l.nextStep, /^Please don't pay again\./);

  await kit.deps.kv.set(keys.fulfilDone(late.key), JSON.stringify({ state: "needs_attention", reservationId: late.reservationId, ref: late.ref, totalSatang: late.quote.dueNowSatang, reason: "x", at: NOW }), DONE_TTL_SECONDS);
  assert.equal((await only(kit, { ref: late.ref })).state, "needs_attention");
});

test("unknown: Beam can't be read - nothing promised, don't pay again; other attempts are still answered", async () => {
  const kit = makeBeamKit();
  const h = await beamHeld(kit);
  for (let i = 0; i < 2; i++) kit.fakeBeam.failNext(/^GET \/api\/v1\/payment-links\//, 503);
  const m = await only(kit, { ref: h.ref });
  assert.equal(m.state, "unknown");
  assert.equal(m.retrySafe, false);
  assert.equal(m.reason, "We couldn't check this payment just now.");
  assert.deepEqual([m.checkIn, m.totalSatang], [FAR_CHECKIN, h.quote.dueNowSatang], "the facts come from our record");
  assert.equal((await only(kit, { ref: h.ref })).state, "open", "the next lookup reads Beam again");
});

test("failureCode words: every documented code, with or without CH_, by method group and offer", () => {
  const codes: Array<[string, string]> = [
    ["CH_CARD_DECLINED", "Your bank declined the card."],
    ["CARD_DECLINED", "Your bank declined the card."],
    ["CH_INSUFFICIENT_FUNDS", "Your bank declined the payment for insufficient funds."],
    ["CH_AUTHENTICATION_FAILED", "The card's security check (3-D Secure or your bank's one-time code) wasn't completed."],
    ["CH_CARD_EXPIRED", "The card has expired."],
    ["CH_CARD_RESTRICTED", "Your bank has restricted this card for this kind of payment (for example online or international payments)."],
    ["CH_CARD_INCORRECT_DETAILS", "Some card details (number, expiry date or security code) weren't accepted."],
    ["CH_CARD_INCORRECT_PIN", "The card PIN was incorrect."],
    ["CH_CARD_PIN_ATTEMPT_EXCEEDED", "There were too many wrong PIN attempts, so your bank has blocked the card for now."],
    ["CH_PROCESSING_FAILED", "Your bank or the payment provider couldn't process the payment."],
    ["REJECTED", "Your payment was declined."],
    ["ch_card_declined", "Your bank declined the card."],
    ["SOMETHING_NEW", "Your payment didn't go through."],
  ];
  for (const [code, reason] of codes) {
    const w = failureWords(code, "card_ewallet", OFFER, false);
    assert.equal(w.reason, reason, code);
    assert.ok(!/\{another\}/.test(w.nextStep), code);
    assert.ok(w.nextStep.endsWith("please make a new booking on magicsamui.com/booking."), code);
  }
  assert.deepEqual(failureWords(null, "card_ewallet", OFFER, false).reason, "Your payment didn't go through.");
  assert.equal(
    failureWords("CH_CARD_DECLINED", "card_ewallet", OFFER, false).nextStep,
    "Try another card or an e-wallet, or ask your bank to allow the payment. You can also choose Thai PromptPay QR (no fee) when you book again. The room hold has been released, so please make a new booking on magicsamui.com/booking.",
  );
  // E-wallets switched off; PromptPay off; PromptPay with a fee.
  assert.match(failureWords("CH_CARD_DECLINED", "card_ewallet", { ...OFFER, ewallets: false }, true).nextStep, /^Try another card, or ask your bank/);
  assert.doesNotMatch(failureWords("CH_CARD_DECLINED", "card_ewallet", { ...OFFER, promptPay: false }, true).nextStep, /PromptPay/);
  assert.match(failureWords("CH_CARD_DECLINED", "card_ewallet", { ...OFFER, promptPayFree: false }, true).nextStep, /choose Thai PromptPay QR when/);
  // A PromptPay page: no card tips; card or e-wallet offered instead.
  assert.equal(
    failureWords("CH_PROCESSING_FAILED", "promptpay", OFFER, false).nextStep,
    "Please try again in a few minutes, or use another payment method. You can choose card or e-wallet instead when you book again. The room hold has been released, so please make a new booking on magicsamui.com/booking.",
  );
  assert.match(failureWords("CH_INSUFFICIENT_FUNDS", "promptpay", OFFER, true).nextStep, /^Please try again, or use another payment method\./);
});

/* ------------------------------------------------ Beam only, per mode ------------------------------------------------ */

test("the index is Beam only: a Stripe checkout writes none of it, and a Stripe ref answers notBeam with no Beam call", async () => {
  const kv = recordingKv(createMemoryKv(() => NOW));
  const stripe = makeParityKit("stripe", { kv });
  const s = await stripe.held();
  assert.ok(s.key.startsWith("cs_test_"));
  assert.deepEqual(kv.writes.filter((w) => w.key.includes(":support:")), [], "no support key on the Stripe path");
  // The Beam kit on the same store (one Redis for both providers, as in production).
  const kit = makeBeamKit({ kv });
  const calls = kit.fakeBeam.calls.length;
  const a = await lookup(kit, { ref: s.ref });
  assert.deepEqual(a, { ok: true, lookup: "ref", found: 0, matches: [], payAgainSafe: true, notBeam: true, message: NOT_BEAM_MESSAGE, checkedAt: new Date(NOW).toISOString() });
  assert.equal((await lookup(kit, { email: TEST_EMAIL, ref: s.ref })).notBeam, true, "email + a Stripe ref: the ref's answer");
  assert.equal((await lookup(kit, { email: TEST_EMAIL })).found, 0, "a Stripe guest's email is not indexed");
  assert.equal(kit.fakeBeam.calls.length, calls, "no Beam call");
  // A Beam checkout on the same store: the support keys, each with 'beam:' after the scope and the 30-day TTL.
  const before = kv.writes.length;
  // Another room: the Stripe hold on the Honeymoon Suite is one of our open holds in the shared store.
  const h = await beamHeld(kit, "card_ewallet", GARDEN);
  const support = kv.writes.slice(before).filter((w) => w.key.includes(":support:"));
  const scope = keyScope(kit.config.paymentMode);
  assert.deepEqual(support.map((w) => w.key).sort(), [
    keys.beamSupportContact(scope, "email", supportCode(TOKEN_SECRET, "email", TEST_EMAIL)),
    keys.beamSupportContact(scope, "phone", supportCode(TOKEN_SECRET, "phone", "66952466011")),
    keys.beamSupportRef(scope, h.ref),
  ].sort());
  for (const w of support) {
    assert.match(w.key, /^msv:beam-playground:beam:support:(ref|email|phone):/);
    assert.equal(w.op, "set");
    assert.equal(w.ttl, SUPPORT_INDEX_TTL_SECONDS);
    assert.deepEqual(JSON.parse(w.value ?? ""), w.key.includes(":ref:") ? { v: 1, ref: h.ref, linkId: h.linkId, at: NOW, rooms: ["garden-suite"] } : [{ v: 1, ref: h.ref, linkId: h.linkId, at: NOW, rooms: ["garden-suite"] }]);
  }
  assert.equal(SUPPORT_INDEX_TTL_SECONDS, 30 * 24 * 3600);
  // No personal data in any key or value the two checkouts wrote.
  assertNoPii(JSON.stringify(kv.writes), "store writes");
});

test("per payment mode: a Stage B (beam-playground) attempt is never answered on beam-live sharing the Redis", async () => {
  const kv = createMemoryKv(() => NOW);
  const stageB = makeBeamKit({ env: BEAM_TEST_ENV, kv });
  const h = await beamHeld(stageB);
  const live = makeBeamKit({ env: BEAM_LIVE_ENV, kv });
  for (const q of [{ ref: h.ref }, { email: TEST_EMAIL }, { phone: "+66 95 246 6011" }]) assert.equal((await lookup(live, q)).found, 0, JSON.stringify(q));
  assert.equal((await lookup(stageB, { email: TEST_EMAIL })).found, 1);
});

/* ------------------------------------------------ the checkout never depends on it ------------------------------------------------ */

/** A memory store whose support keys fail (throw) or never answer (hang); every other key works. */
function supportBrokenKv(how: "throw" | "hang"): KvStore {
  const inner = createMemoryKv(() => NOW);
  const broken = <T>(key: string, fn: () => Promise<T>): Promise<T> =>
    key.includes(":beam:support:") ? (how === "throw" ? Promise.reject(new Error(`ECONNRESET writing ${key}`)) : new Promise<T>(() => undefined)) : fn();
  return { ...inner, get: (k) => broken(k, () => inner.get(k)), set: (k, v, t) => broken(k, () => inner.set(k, v, t)) };
}

test("a Redis error while indexing never breaks the Beam checkout (logged by name, no key or personal data)", async () => {
  const kit = makeBeamKit({ kv: supportBrokenKv("throw") });
  const res = await beamCheckout(kit);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(res.body.ok);
  const linkId = new URL(res.body.redirectUrl).pathname.split("/").pop() ?? "";
  assert.equal(kit.fakeBeam.link(linkId).status, "ACTIVE", "the link stays open");
  assert.ok(await readRecord(kit.deps.kv, linkId), "the PaymentRecord is written");
  assert.ok(!kit.logs.some((l) => l.message === "checkout_after_session_failed"));
  const failed = kit.logs.filter((l) => l.message === "beam_support_index_failed");
  assert.deepEqual(failed.map((l) => l.data), [{ ref: res.body.ref, error: "Error" }]);
  assert.ok(!kit.logText().includes(":beam:support:"), "the key is not logged");
  assertNoPii(kit.logText(), "logs");
  // The guest still pays and is confirmed.
  kit.fakeBeam.pay(linkId, "CARD");
  assert.equal((await fulfilPayment(beamKeyOf(linkId), kit.deps, kit.gw)).state, "confirmed");
});

test("a Redis that never answers delays the Beam checkout by at most 750 ms", async () => {
  const kit = makeBeamKit({ kv: supportBrokenKv("hang") });
  const started = Date.now();
  const res = await beamCheckout(kit);
  const tookMs = Date.now() - started;
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(tookMs < 3_000, `took ${tookMs} ms`);
  assert.ok(kit.logs.some((l) => l.message === "beam_support_index_slow" && l.data?.waitedMs === 750));
});

test("near the checkout's deadline the index is skipped (the checkout's own last steps come first)", async () => {
  const kit = makeBeamKit({ gateway: { deadlineMs: 2_500, clock: () => 0 } });
  const res = await beamCheckout(kit);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(kit.logs.some((l) => l.message === "beam_support_index_skipped" && l.data?.remainingMs === 2_500));
  const lookupKit = makeBeamKit({ kv: kit.deps.kv });
  assert.equal((await lookup(lookupKit, { email: TEST_EMAIL })).found, 0);
});

test("the support keys carry 'beam:' after the mode scope and can't be a Stripe key", () => {
  for (const scope of ["beam-live", "beam-playground"]) {
    const ks = [keys.beamSupportRef(scope, "MSV-20261005-ABCD"), keys.beamSupportContact(scope, "email", "c0de"), keys.beamSupportContact(scope, "phone", "c0de"), keys.beamSupportRate(scope, "all")];
    for (const k of ks) assert.match(k, new RegExp(`^msv:${scope}:beam:support:`), k);
    assert.equal(new Set(ks).size, ks.length);
  }
  assert.equal(supportEntry("MSV-20261005-ABCD", "not a link id", NOW, []), null);
  assert.equal(supportEntry("MSV-1", "Lnk0000001", NOW, []), null);
  assert.deepEqual(supportEntry("MSV-20261005-ABCD", "Lnk0000001", NOW, ["garden-suite", "garden-suite", "Bad Slug"])?.rooms, ["garden-suite"]);
});

/* ------------------------------------------------ review round 1 ------------------------------------------------ */

test("an email address alone: only how many attempts it has (detailsWithheld, payAgainSafe false) - no state, reason, code or ref, no Beam call", async () => {
  const kit = makeBeamKit();
  const h = await beamHeld(kit);
  kit.fakeBeam.decline(h.linkId, "CARD", "CH_INSUFFICIENT_FUNDS");
  const beamCalls = kit.fakeBeam.calls.length;
  for (const email of [TEST_EMAIL, ` ${TEST_EMAIL.toUpperCase()} `]) {
    const res = await call(kit, { email });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      ok: true,
      lookup: "email",
      found: 1,
      matches: [],
      payAgainSafe: false,
      detailsWithheld: true,
      message: DETAILS_WITHHELD_MESSAGE,
      checkedAt: new Date(NOW).toISOString(),
    });
    const text = JSON.stringify(res.body);
    for (const secret of [h.ref, "INSUFFICIENT", "failed", "declined", FAR_CHECKIN]) assert.ok(!text.includes(secret), secret);
  }
  assert.equal(kit.fakeBeam.calls.length, beamCalls, "no Beam call for an email alone");
  assert.ok(kit.logs.some((l) => l.message === "support_lookup" && l.data?.by === "email" && l.data?.detailsWithheld === true && l.data?.found === 1));
  // With the booking's ref: the full answer.
  const full = await only(kit, { email: TEST_EMAIL, ref: h.ref });
  assert.deepEqual([full.state, full.failureCode, full.reason], ["failed", "CH_INSUFFICIENT_FUNDS", "Your bank declined the payment for insufficient funds."]);
  // Another email with that ref: exactly what the ref alone answers (nothing about the email); an unknown ref: nothing.
  const other = await lookup(kit, { email: "someone-else@example.com", ref: h.ref });
  assert.equal(other.lookup, "email_ref");
  assert.deepEqual(other.matches, (await lookup(kit, { ref: h.ref })).matches);
  const none = await lookup(kit, { email: TEST_EMAIL, ref: "MSV-20261005-ZZZZ" });
  assert.deepEqual([none.found, none.matches, none.message, none.payAgainSafe], [0, [], NOTHING_FOUND_MESSAGE, true]);
  assertNoPii(kit.logText(), "logs");
});

test("payAgainSafe: confirmed or refunded attempts of other bookings never block paying again after a failed card", async () => {
  const kit = makeBeamKit();
  const earlier = await beamHeld(kit);
  kit.fakeBeam.pay(earlier.linkId, "CARD");
  assert.equal((await fulfilPayment(earlier.key, kit.deps, kit.gw)).state, "confirmed");
  kit.now.ms += 60_000;
  const failed = await beamHeld(kit, "card_ewallet", GARDEN);
  kit.fakeBeam.decline(failed.linkId, "CARD", "CH_CARD_DECLINED");
  const a = await lookup(kit, { phone: "66952466011" });
  assert.deepEqual(a.matches.map((m) => [m.ref, m.state]), [[failed.ref, "failed"], [earlier.ref, "confirmed"]]);
  assert.equal(a.payAgainSafe, true);
  assert.equal(a.matches[0].retrySafe, true);
  assert.match(a.matches[0].nextStep, /^Try another card or an e-wallet, or ask your bank to allow the payment\./);
  // The earlier booking refunded before it was confirmed: still no block.
  await kit.deps.kv.set(keys.fulfilDone(earlier.key), JSON.stringify({ state: "needs_attention", reservationId: earlier.reservationId, ref: earlier.ref, totalSatang: earlier.quote.dueNowSatang, refunded: true, at: NOW }), DONE_TTL_SECONDS);
  const r = await lookup(kit, { phone: "66952466011" });
  assert.deepEqual([r.payAgainSafe, r.matches[1].state, r.matches[0].retrySafe], [true, "refunded", true]);
});

test("payAgainSafe: an older PromptPay payment still pending blocks paying again on a newer failed card (don't pay again, naming it)", async () => {
  const kit = makeBeamKit();
  const qr = await beamHeld(kit, "promptpay");
  const pending = kit.fakeBeam.payPending(qr.linkId, "QR_PROMPT_PAY");
  kit.now.ms += 60_000;
  const card = await beamHeld(kit, "card_ewallet", GARDEN);
  kit.fakeBeam.decline(card.linkId, "CARD", "CH_CARD_DECLINED");
  const wait = `Please don't pay again. Your other recent payment attempt (${qr.ref}) is still being processed or checked, so paying again now could charge you twice. We'll confirm your booking or contact you shortly.`;
  for (const q of [{ phone: "+66 95 246 6011" }, { email: TEST_EMAIL, ref: card.ref }]) {
    const a = await lookup(kit, q);
    assert.equal(a.payAgainSafe, false, JSON.stringify(q));
    assert.deepEqual(a.matches.map((m) => [m.ref, m.state]), [[card.ref, "failed"], [qr.ref, "processing"]]);
    const [failed, waiting] = a.matches;
    assert.equal(failed.nextStep, wait);
    assert.equal(failed.retrySafe, false);
    assert.deepEqual([failed.reason, failed.failureCode], ["Your bank declined the card.", "CH_CARD_DECLINED"], "what happened stays");
    assert.match(waiting.nextStep, /^Please don't pay again\./);
  }
  assert.ok(kit.logs.some((l) => l.message === "support_lookup" && l.data?.payAgainSafe === false));
  // The card's ref alone sees only that attempt (the bot looks up the sender's own number first).
  const alone = await lookup(kit, { ref: card.ref });
  assert.deepEqual([alone.payAgainSafe, alone.matches[0].retrySafe], [true, true]);
  // The QR fails: nothing blocks any more, the card's own next step is back.
  kit.fakeBeam.failCharge(pending.chargeId, "CH_PROCESSING_FAILED");
  const after = await lookup(kit, { phone: "+66 95 246 6011" });
  assert.equal(after.payAgainSafe, true);
  assert.match(after.matches[0].nextStep, /^Try another card or an e-wallet/);
  // An attempt Beam can't be read for blocks too (nothing is promised about it).
  for (let i = 0; i < 2; i++) kit.fakeBeam.failNext(new RegExp(`^GET /api/v1/payment-links/${qr.linkId}$`), 503);
  const unknown = await lookup(kit, { phone: "+66 95 246 6011" });
  assert.deepEqual(unknown.matches.map((m) => [m.state, m.retrySafe]), [["failed", false], ["unknown", false]]);
  assert.equal(unknown.payAgainSafe, false);
  assert.equal(unknown.matches[0].nextStep, wait);
});

test("Beam is read for the newest 3 attempts only (and always for the ref a query names); older ones answer from our own markers", async () => {
  const kit = makeBeamKit();
  const h = await beamHeld(kit);
  const template = await readRecord(kit.deps.kv, h.linkId);
  assert.ok(template);
  const phoneCode = supportCode(TOKEN_SECRET, "phone", "66952466011");
  const emailCode = supportCode(TOKEN_SECRET, "email", TEST_EMAIL);
  /** An earlier attempt of the same guest: its record and its index entries (Beam does not know its link). */
  const earlier = async (i: number, at: number): Promise<PaymentRecord> => {
    const record: PaymentRecord = { ...template, linkId: `LnkEarlier${i}`, ref: `MSV-20261005-ER${"CDEF"[i]}${"CDEF"[i]}`, createdAt: at, expiresAt: at + 30 * 60_000 };
    await writeRecord(kit.deps.kv, record);
    const entry = supportEntry(record.ref, record.linkId, at, ["honeymoon-suite"]);
    assert.ok(entry);
    await writeSupportIndex(kit.deps.kv, { mode: kit.config.paymentMode, entry, emailCode, phoneCodes: [phoneCode] }, NOW);
    return record;
  };
  const s1 = await earlier(0, NOW - 60_000);
  const s2 = await earlier(1, NOW - 120_000);
  const recent = await earlier(2, NOW - 180_000);
  const old = await earlier(3, NOW - 3 * 24 * 3_600_000);
  const linksRead = (from: number) =>
    kit.fakeBeam.calls
      .slice(from)
      .filter((c) => c.method === "GET" && c.path.startsWith("/api/v1/payment-links/"))
      .map((c) => c.path.split("/").pop());
  let from = kit.fakeBeam.calls.length;
  const a = await lookup(kit, { phone: "66952466011" });
  assert.deepEqual(new Set(linksRead(from)), new Set([h.linkId, s1.linkId, s2.linkId]), "the newest 3 only");
  assert.equal(SUPPORT_LOOKUP_BEAM_READS, 3);
  const byRef = new Map(a.matches.map((m) => [m.ref, m]));
  assert.equal(byRef.get(h.ref)?.state, "open");
  assert.equal(byRef.get(s1.ref)?.state, "unknown", "read, but Beam does not know it");
  // Not read: still inside its window + grace + 24 h -> unknown; long over -> expired (nothing reached us).
  assert.deepEqual([byRef.get(recent.ref)?.state, byRef.get(recent.ref)?.reason], ["unknown", "We didn't check this earlier payment attempt just now."]);
  assert.deepEqual([byRef.get(old.ref)?.state, byRef.get(old.ref)?.reason, byRef.get(old.ref)?.retrySafe], ["expired", "This earlier payment page has closed, and no payment from it has reached us.", false]);
  assert.ok(Date.parse(byRef.get(old.ref)?.createdAt ?? "") + 30 * 60_000 + 20 * 60_000 + BEAM_PENDING_BLOCK_MS <= NOW);
  // Fulfil's paid marker: paid, from our own store.
  await kit.deps.kv.set(keys.paidPending(beamKeyOf(recent.linkId)), "{}", DONE_TTL_SECONDS);
  assert.equal((await lookup(kit, { phone: "66952466011" })).matches.find((m) => m.ref === recent.ref)?.state, "paid");
  // The ref a query names is always read, in place of the third newest.
  from = kit.fakeBeam.calls.length;
  await lookup(kit, { email: TEST_EMAIL, ref: old.ref });
  assert.deepEqual(new Set(linksRead(from)), new Set([h.linkId, s1.linkId, old.linkId]));
  // A finished attempt needs no Beam call wherever it is.
  from = kit.fakeBeam.calls.length;
  await lookup(kit, { ref: h.ref });
  assert.deepEqual(linksRead(from), [h.linkId]);
});

test("retention: an index entry older than 30 days is dropped when the list is written or read, even if the key was renewed", async () => {
  const kit = makeBeamKit();
  const scope = keyScope(kit.config.paymentMode);
  const code = supportCode(TOKEN_SECRET, "phone", "447700900123");
  const key = keys.beamSupportContact(scope, "phone", code);
  const DAY = 24 * 3_600_000;
  const write = async (i: number) => {
    const entry = supportEntry(`MSV-20261005-RT${"CDE"[i]}${"CDE"[i]}`, `LnkRetain${i}`, kit.now.ms, ["garden-suite"]);
    assert.ok(entry);
    await writeSupportIndex(kit.deps.kv, { mode: kit.config.paymentMode, entry, emailCode: null, phoneCodes: [code] });
    return entry;
  };
  const e1 = await write(0);
  kit.now.ms += 20 * DAY;
  const e2 = await write(1);
  kit.now.ms += 20 * DAY;
  const e3 = await write(2);
  // The third write renewed the key; the first entry (40 days old) is gone from what is stored.
  const stored = JSON.parse((await kit.deps.kv.get(key)) ?? "[]") as Array<{ ref: string }>;
  assert.deepEqual(stored.map((e) => e.ref), [e3.ref, e2.ref]);
  assert.ok(!stored.some((e) => e.ref === e1.ref));
  // Read 11 days later: the second entry is now 31 days old and not answered either.
  kit.now.ms += 11 * DAY;
  assert.deepEqual((await readSupportList(kit.deps.kv, key, kit.now.ms)).map((e) => e.ref), [e3.ref]);
  assert.equal((await lookup(kit, { phone: "+44 7700 900123" })).found, 1);
  // A ref entry whose own time is past the retention is not answered (whatever its key's TTL says).
  const stale = supportEntry("MSV-20261005-RTZZ", "LnkRetainZ", kit.now.ms - 31 * DAY, []);
  assert.ok(stale);
  await kit.deps.kv.set(keys.beamSupportRef(scope, stale.ref), JSON.stringify(stale), SUPPORT_INDEX_TTL_SECONDS);
  assert.equal(await readSupportRef(kit.deps.kv, scope, stale.ref, kit.now.ms), null);
  assert.equal((await lookup(kit, { ref: stale.ref })).found, 0);
});

test("failureCode: only Beam's code shape is passed on (/^[A-Z0-9_]{1,64}$/i), anything else is null with the generic words", async () => {
  const kit = makeBeamKit();
  const h = await beamHeld(kit);
  for (const [code, shown] of [
    ["<b>4111111111111111</b>", null],
    [`CH_${"X".repeat(62)}`, null],
    ["CH CARD DECLINED", null],
    ["CH_CARD_DECLINED", "CH_CARD_DECLINED"],
    [`CH_${"X".repeat(61)}`, `CH_${"X".repeat(61)}`],
    ["ch_card_declined", "ch_card_declined"],
  ] as const) {
    kit.now.ms += 1_000;
    kit.fakeBeam.decline(h.linkId, "CARD", code);
    const m = await only(kit, { ref: h.ref });
    assert.equal(m.state, "failed", code);
    assert.equal(m.failureCode, shown, code);
    if (shown === null) {
      assert.equal(m.reason, "Your payment didn't go through.", code);
      assert.ok(!JSON.stringify(m).includes("4111"), "no digits echoed");
    }
  }
});

test("the log: 'unconfigured' once per server instance; rejected tokens counted and logged without the header's contents", async () => {
  const kit = makeBeamKit();
  const instance = lookupInstanceState();
  for (let i = 0; i < 3; i++) assert.equal((await call(kit, { ref: "MSV-20261005-ABCD" }, { env: {}, deps: { instance } })).status, 503);
  assert.equal(kit.logs.filter((l) => l.message === "support_lookup_unconfigured").length, 1);
  for (const auth of [null, `Bearer wrong-${SECRET}`, `Basic ${SECRET}`]) assert.equal((await call(kit, { ref: "MSV-20261005-ABCD" }, { auth, deps: { instance } })).status, 401);
  assert.deepEqual(
    kit.logs.filter((l) => l.message === "support_lookup_unauthorized").map((l) => l.data),
    [
      { count: 1, header: "missing" },
      { count: 2, header: "present" },
      { count: 3, header: "present" },
    ],
  );
  assert.ok(!kit.logText().includes(SECRET) && !kit.logText().includes("wrong-") && !kit.logText().includes("Basic"), "never the header");
  // Without an instance's state (a fresh one per request), every request logs it.
  for (let i = 0; i < 2; i++) await call(kit, { ref: "MSV-20261005-ABCD" }, { env: {} });
  assert.equal(kit.logs.filter((l) => l.message === "support_lookup_unconfigured").length, 3);
});
