// Beam keys, payment record, signed note and hold identifiers (design S2.4):
// - every Stripe key name, TTL and hold identifier stays byte-identical, and every Beam key carries "beam:";
// - the PaymentRecord round-trips with its TTL (past the farthest check-out plus the dispute window), stores
//   only its own fields (no personal data) and
//   reads back null when missing, malformed or another link's;
// - the signed internalNote round-trips; any edited field, a structural change or another secret fails;
//   it stays within 500 characters and carries no email or phone;
// - parseHoldIdentifier never reads a Beam hold (-B, -B-TEST); parseBeamHoldIdentifier reads only those.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { BOOKING_WINDOW_MONTHS, MAX_NIGHTS } from "../config.ts";
import { addMonths, validateStayDates } from "../dates.ts";
import { createMemoryKv } from "../kv.ts";
import type { KvStore } from "../kv.ts";
import {
  BEAM_HOLD_SUFFIX,
  BEAM_DISPUTE_WINDOW_DAYS,
  BEAM_KEY_PREFIX,
  BEAM_RECORD_TTL_SECONDS,
  DONE_TTL_SECONDS,
  LOCK_TTL_SECONDS,
  TEST_HOLD_SUFFIX,
  beamKeyOf,
  holdIdentifier,
  keys,
  linkIdOf,
  parseBeamHoldIdentifier,
  parseHoldIdentifier,
} from "../lock.ts";
import { TOKEN_SECRET, recordingKv } from "../testkit.ts";
import type { PaymentMode } from "../types.ts";
import { BEAM_NOTE_MAX_LENGTH, BEAM_NOTE_VERSION, buildBeamNote, isPaymentRecord, readRecord, recordToMeta, verifyBeamNote, writeRecord } from "./beamRecord.ts";
import type { BeamNote, PaymentRecord } from "./beamRecord.ts";

const REF = "MSV-20261022-7F3K";
const LINK_ID = "rGtqz6DafS";
const CHARGE_ID = "ch_3Ns8XkLmQ2";
const SESSION_ID = "cs_test_a1B2c3";
/** A Cloudbeds reservation id as the live API answers them (13 digits). */
const RESERVATION_ID = "6954439751495";
const T0 = Date.parse("2026-10-22T03:00:00Z");
const EXPIRES = T0 + 30 * 60_000;

const NOTE: BeamNote = {
  ref: REF,
  reservationId: RESERVATION_ID,
  roomsSatang: 2_400_000,
  feeSatang: 72_000,
  totalSatang: 2_472_000,
  payMethod: "card_ewallet",
  checkIn: "2027-01-10",
  checkOut: "2027-01-13",
  mode: "beam-live",
  arrivalLate: true,
  hasRequests: false,
  noteSaved: null,
  termsVersion: "2026-10-07",
  expiresAt: EXPIRES,
};

const RECORD: PaymentRecord = {
  v: 1,
  linkId: LINK_ID,
  ...NOTE,
  merchantId: "m_FakeBeamMerchant0000000000",
  createdAt: T0,
};

/** The record's JSON exactly as writeRecord must store it (the field order of the design). */
const RECORD_JSON =
  `{"v":1,"linkId":"${LINK_ID}","ref":"${REF}","reservationId":"${RESERVATION_ID}","roomsSatang":2400000,"feeSatang":72000,` +
  `"totalSatang":2472000,"payMethod":"card_ewallet","checkIn":"2027-01-10","checkOut":"2027-01-13","mode":"beam-live",` +
  `"merchantId":"m_FakeBeamMerchant0000000000","arrivalLate":true,"hasRequests":false,"noteSaved":null,"termsVersion":"2026-10-07",` +
  `"createdAt":${T0},"expiresAt":${EXPIRES}}`;

/** Personal data a careless caller might pass along: none of it may reach Redis or Beam. */
const PII = { email: "guest@example.com", phone: "+66 81 234 5678", guestName: "Ann Guest", requests: "Call me on 0812345678" };

/** The note's signature, computed independently of beamRecord.ts. */
const sig = (body: string, secret = TOKEN_SECRET) => createHmac("sha256", secret).update(body).digest("base64url").slice(0, 27);
const signed = (body: string, secret = TOKEN_SECRET) => `${body}|s=${sig(body, secret)}`;
const bodyOf = (note: string) => note.slice(0, note.lastIndexOf("|s="));

/* ----------------------------------- keys ----------------------------------- */

test("every Stripe key name, TTL and hold suffix is byte-identical; the Beam keys are added after them", () => {
  assert.deepEqual(
    {
      fulfilLock: keys.fulfilLock(SESSION_ID),
      fulfilDone: keys.fulfilDone(SESSION_ID),
      fulfilStepFee: keys.fulfilStep(SESSION_ID, "fee"),
      fulfilStepPayment: keys.fulfilStep(SESSION_ID, "payment"),
      fulfilStepAttempt: keys.fulfilStep(SESSION_ID, "payment-attempt"),
      fulfilStepPaidNote: keys.fulfilStep(SESSION_ID, "paid-note"),
      releaseLock: keys.releaseLock("48213377"),
      releaseDone: keys.releaseDone("48213377"),
      reservationPaid: keys.reservationPaid("48213377"),
      paidPending: keys.paidPending(SESSION_ID),
      paidIndex: keys.paidIndex("live"),
      hold: keys.hold("48213377"),
      holdIndex: keys.holdIndex(),
      booking: keys.booking(REF),
      abandoned: keys.abandoned(SESSION_ID),
      alerted: keys.alerted("live", "sweep-stale"),
      intent: keys.intent(REF),
      intentIndex: keys.intentIndex(),
      unitLock: keys.unitLock("honeymoon-1"),
      clientHolds: keys.clientHolds("9f86d081"),
      lastSweep: keys.lastSweep("live"),
      sweepCloudbedsFailures: keys.sweepCloudbedsFailures("live"),
      checkoutReadFailures: keys.checkoutReadFailures("stripe-test"),
      pendingAlert: keys.pendingAlert("live", "a1"),
      pendingAlertIndex: keys.pendingAlertIndex("live"),
      badSignatures: keys.badSignatures("live"),
      noRecordReported: keys.noRecordReported("live", "48213377"),
    },
    {
      fulfilLock: "msv:lock:fulfil:cs_test_a1B2c3",
      fulfilDone: "msv:done:fulfil:cs_test_a1B2c3",
      fulfilStepFee: "msv:step:fulfil:cs_test_a1B2c3:fee",
      fulfilStepPayment: "msv:step:fulfil:cs_test_a1B2c3:payment",
      fulfilStepAttempt: "msv:step:fulfil:cs_test_a1B2c3:payment-attempt",
      fulfilStepPaidNote: "msv:step:fulfil:cs_test_a1B2c3:paid-note",
      releaseLock: "msv:lock:release:48213377",
      releaseDone: "msv:done:release:48213377",
      reservationPaid: "msv:paid:res:48213377",
      paidPending: "msv:paid:session:cs_test_a1B2c3",
      paidIndex: "msv:live:paid:open",
      hold: "msv:hold:48213377",
      holdIndex: "msv:holds:open",
      booking: "msv:booking:MSV-20261022-7F3K",
      abandoned: "msv:abandoned:cs_test_a1B2c3",
      alerted: "msv:live:alerted:sweep-stale",
      intent: "msv:intent:MSV-20261022-7F3K",
      intentIndex: "msv:intents:open",
      unitLock: "msv:lock:unit:honeymoon-1",
      clientHolds: "msv:holds:client:9f86d081",
      lastSweep: "msv:live:sweep:last",
      sweepCloudbedsFailures: "msv:live:sweep:cbfail",
      checkoutReadFailures: "msv:stripe-test:checkout:readfail",
      pendingAlert: "msv:live:alert:pending:a1",
      pendingAlertIndex: "msv:live:alerts:pending",
      badSignatures: "msv:live:webhook:badsig",
      noRecordReported: "msv:live:norecord:48213377",
    },
  );
  // No Stripe key was renamed, removed or reordered; every new one is a Beam key.
  const names = Object.keys(keys);
  assert.deepEqual(
    names.filter((n) => !n.startsWith("beam")),
    [
      "fulfilLock", "fulfilDone", "fulfilStep", "releaseLock", "releaseDone", "reservationPaid", "paidPending", "paidIndex", "hold",
      "holdIndex", "booking", "abandoned", "alerted", "intent", "intentIndex", "unitLock", "clientHolds", "lastSweep",
      "sweepCloudbedsFailures", "checkoutReadFailures", "pendingAlert", "pendingAlertIndex", "badSignatures", "noRecordReported",
    ],
  );
  assert.deepEqual(
    names.filter((n) => n.startsWith("beam")),
    [
      "beamPayment", "beamCharge", "beamPrimary", "beamLinksOpen", "beamLinksWatch", "beamReported", "beamTxn", "beamBadSignatures",
      "beamRateLimited", "beamDisableFail", "beamReadFailures", "beamPageFail", "beamPaused", "beamDeepScan", "beamSweepFailures",
      "beamLinksPending", "beamLinksWatchRead", "beamSupportRef", "beamSupportContact", "beamSupportRate", "beamRefunds", "beamRefundsLock",
    ],
  );
  assert.equal(LOCK_TTL_SECONDS, 120);
  assert.equal(DONE_TTL_SECONDS, 30 * 24 * 3600);
  assert.equal(TEST_HOLD_SUFFIX, "-TEST");
});

test("every Beam key carries 'beam:' right after 'msv:' or the mode scope, and none can be a Stripe key", () => {
  assert.equal(keys.beamPayment(LINK_ID), "msv:beam:pay:rGtqz6DafS");
  assert.equal(keys.beamCharge(CHARGE_ID), "msv:beam:charge:ch_3Ns8XkLmQ2");
  assert.equal(keys.beamRefunds(LINK_ID), "msv:beam:refunds:rGtqz6DafS");
  assert.equal(keys.beamRefundsLock(LINK_ID), "msv:beam:lock:refunds:rGtqz6DafS");
  assert.equal(keys.beamLinksOpen("beam-live"), "msv:beam-live:beam:links:open");
  assert.equal(keys.beamLinksWatch("beam-live"), "msv:beam-live:beam:links:watch");
  assert.equal(keys.beamReadFailures("beam-live"), "msv:beam-live:beam:readfail");
  assert.equal(keys.beamSweepFailures("beam-live"), "msv:beam-live:beam:sweepfail");
  assert.equal(keys.beamLinksPending("beam-live"), "msv:beam-live:beam:links:pending");
  assert.equal(keys.beamLinksWatchRead("beam-live"), "msv:beam-live:beam:links:watchread");
  const stripeKeys = new Set(
    [SESSION_ID, LINK_ID, CHARGE_ID, beamKeyOf(LINK_ID)].flatMap((id) => [
      keys.fulfilLock(id), keys.fulfilDone(id), keys.paidPending(id), keys.abandoned(id), keys.hold(id), keys.releaseDone(id),
    ]),
  );
  for (const scope of ["live", "beam-live", "beam-playground"]) {
    const beamKeys = [
      keys.beamPayment(LINK_ID),
      keys.beamCharge(CHARGE_ID),
      keys.beamPrimary(LINK_ID),
      keys.beamRefunds(LINK_ID),
      keys.beamRefundsLock(LINK_ID),
      keys.beamLinksOpen(scope),
      keys.beamLinksWatch(scope),
      ...(["dup-charge", "record-missing", "unknown-payment", "foreign-link", "refund-ambiguous", "scan-refused", "merchant-switch"] as const).map((kind) => keys.beamReported(scope, kind, LINK_ID)),
      keys.beamTxn(scope, CHARGE_ID),
      keys.beamBadSignatures(scope),
      keys.beamRateLimited(scope),
      keys.beamDisableFail(scope, LINK_ID),
      keys.beamReadFailures(scope),
      keys.beamPageFail(scope),
      keys.beamPaused(scope),
      keys.beamDeepScan(scope),
      keys.beamSweepFailures(scope),
      keys.beamLinksPending(scope),
      keys.beamLinksWatchRead(scope),
    ];
    assert.equal(new Set(beamKeys).size, beamKeys.length, `${scope}: every Beam key is distinct`);
    for (const key of beamKeys) {
      assert.match(key, new RegExp(`^msv:(beam|${scope}:beam):`), key);
      assert.ok(!stripeKeys.has(key), key);
    }
    assert.notEqual(keys.beamBadSignatures(scope), keys.badSignatures(scope), "Beam's bad-signature count is its own");
  }
});

test("a Beam payment key is 'beam:' + the link id; linkIdOf reads only that", () => {
  assert.equal(BEAM_KEY_PREFIX, "beam:");
  assert.equal(beamKeyOf(LINK_ID), "beam:rGtqz6DafS");
  assert.equal(linkIdOf(beamKeyOf(LINK_ID)), LINK_ID);
  assert.equal(keys.fulfilDone(beamKeyOf(LINK_ID)), "msv:done:fulfil:beam:rGtqz6DafS", "the shared core's keys of a Beam payment carry 'beam:'");
  for (const key of [LINK_ID, SESSION_ID, "beam:", "beam:a b", "beam:a|b", `beam:${"x".repeat(65)}`, "BEAM:rGtqz6DafS", " beam:rGtqz6DafS", ""]) {
    assert.equal(linkIdOf(key), null, JSON.stringify(key));
  }
});

/* ---------------------------------- record ---------------------------------- */

test("writeRecord stores exactly the record's own fields for 708 days; readRecord reads it back until then", async () => {
  const now = { ms: T0 };
  const kv = recordingKv(createMemoryKv(() => now.ms));
  await writeRecord(kv, { ...RECORD, ...PII } as PaymentRecord);
  assert.equal(BEAM_RECORD_TTL_SECONDS, 708 * 24 * 3600, "18 months of 31 days + the 120-day dispute window + 30 days");
  assert.equal(BEAM_DISPUTE_WINDOW_DAYS, 120);
  assert.deepEqual(kv.writes, [{ op: "set", key: "msv:beam:pay:rGtqz6DafS", value: RECORD_JSON, ttl: 61_171_200 }]);
  assert.ok(!RECORD_JSON.includes("@") && !RECORD_JSON.includes("+66"), "no personal data is stored");

  assert.deepEqual(await readRecord(kv, LINK_ID), RECORD);
  // Still there a second before the TTL, gone at the TTL.
  now.ms = T0 + BEAM_RECORD_TTL_SECONDS * 1000 - 1000;
  assert.deepEqual(await readRecord(kv, LINK_ID), RECORD);
  now.ms = T0 + BEAM_RECORD_TTL_SECONDS * 1000;
  assert.equal(await readRecord(kv, LINK_ID), null);
});

test("the record TTL covers the farthest check-out validateStayDates accepts plus the 120-day dispute window, on every booking day", async () => {
  const DAY = 86_400_000;
  const limits = (today: string) => ({ today, maxNights: MAX_NIGHTS, bookingWindowMonths: BOOKING_WINDOW_MONTHS });
  let shortest = Number.POSITIVE_INFINITY;
  // Every booking day of four years (a leap year included).
  for (let day = Date.parse("2026-01-01T00:00:00Z"); day < Date.parse("2030-01-01T00:00:00Z"); day += DAY) {
    const today = new Date(day).toISOString().slice(0, 10);
    const checkOut = addMonths(today, BOOKING_WINDOW_MONTHS);
    const checkIn = new Date(Date.parse(`${checkOut}T00:00:00Z`) - DAY).toISOString().slice(0, 10);
    const dayAfter = new Date(Date.parse(`${checkOut}T00:00:00Z`) + DAY).toISOString().slice(0, 10);
    assert.equal(validateStayDates(checkIn, checkOut, limits(today)), null, `${today}: ${checkOut} is the farthest check-out`);
    assert.equal(validateStayDates(checkIn, dayAfter, limits(today)), "beyond_booking_window", `${today}: ${dayAfter} is refused`);
    // Written at the earliest moment of the Bangkok booking day (00:00 +07:00); needed until the END of the
    // dispute window's last day (check-out day + 120 days, 24:00 +07:00).
    const writtenAt = Date.parse(`${today}T00:00:00+07:00`);
    const neededUntil = Date.parse(`${checkOut}T00:00:00+07:00`) + (BEAM_DISPUTE_WINDOW_DAYS + 1) * DAY;
    const spare = writtenAt + BEAM_RECORD_TTL_SECONDS * 1000 - neededUntil;
    assert.ok(spare >= 0, `${today}: the record would expire ${Math.ceil(-spare / DAY)} days too early`);
    shortest = Math.min(shortest, spare);
  }
  assert.ok(shortest >= 20 * DAY, `at least 20 days of margin on every booking day (${shortest / DAY} days)`);

  // The edge case of round-2 triage: booked on 22 Oct 2026 for a stay ending 22 Apr 2028, a chargeback 120 days later.
  const now = { ms: Date.parse("2026-10-22T03:00:00Z") };
  const kv = createMemoryKv(() => now.ms);
  const farthest = addMonths("2026-10-22", BOOKING_WINDOW_MONTHS);
  assert.equal(farthest, "2028-04-22");
  await writeRecord(kv, { ...RECORD, checkIn: "2028-04-19", checkOut: farthest, createdAt: now.ms, expiresAt: now.ms + 30 * 60_000 });
  now.ms = Date.parse(`${farthest}T23:59:59+07:00`) + BEAM_DISPUTE_WINDOW_DAYS * DAY;
  assert.equal((await readRecord(kv, LINK_ID))?.checkOut, farthest, "still mapped to its booking at the end of the dispute window");
});

test("readRecord: null when the record is missing, unreadable, malformed or another link's; a Redis failure throws", async () => {
  const kv = createMemoryKv(() => T0);
  assert.equal(await readRecord(kv, LINK_ID), null, "missing");
  await kv.set(keys.beamPayment(LINK_ID), "{not json", 60);
  assert.equal(await readRecord(kv, LINK_ID), null, "unreadable");
  await kv.set(keys.beamPayment(LINK_ID), JSON.stringify({ ...RECORD, totalSatang: RECORD.totalSatang + 1 }), 60);
  assert.equal(await readRecord(kv, LINK_ID), null, "rooms + fee != total");
  await kv.set(keys.beamPayment(LINK_ID), JSON.stringify({ ...RECORD, v: 2 }), 60);
  assert.equal(await readRecord(kv, LINK_ID), null, "another version");
  await kv.set(keys.beamPayment(LINK_ID), JSON.stringify({ ...RECORD, linkId: "HFF4n25LYl" }), 60);
  assert.equal(await readRecord(kv, LINK_ID), null, "another link's record under this key");
  await kv.set(keys.beamPayment(LINK_ID), JSON.stringify({ ...RECORD, ...PII }), 60);
  assert.deepEqual(await readRecord(kv, LINK_ID), RECORD, "only the record's own fields come back");
  assert.equal(await readRecord(kv, "bad id"), null);

  const down: KvStore = { ...kv, get: async () => Promise.reject(new Error("redis down")) };
  await assert.rejects(readRecord(down, LINK_ID), /redis down/, "an outage never reads as a missing record");
});

test("writeRecord refuses a malformed record and writes nothing", async () => {
  const kv = recordingKv(createMemoryKv(() => T0));
  const bad: Array<[string, Record<string, unknown>]> = [
    ["v", { v: 2 }],
    ["linkId", { linkId: "bad id" }],
    ["merchantId", { merchantId: "" }],
    ["merchantId", { merchantId: "m 1" }],
    ["createdAt", { createdAt: 0 }],
    ["mode", { mode: "Beam Live" }],
    ["ref", { ref: "MSV-1" }],
    ["reservationId", { reservationId: "48|21" }],
    ["roomsSatang", { roomsSatang: -1 }],
    ["feeSatang", { feeSatang: 1.5 }],
    ["totalSatang", { totalSatang: 2_472_001 }],
    ["checkIn", { checkIn: "2027-02-30" }],
    ["checkOut", { checkOut: "13/01/2027" }],
    ["payMethod", { payMethod: "card" }],
    ["termsVersion", { termsVersion: "2026|10" }],
    ["arrivalLate", { arrivalLate: "yes" }],
    ["noteSaved", { noteSaved: undefined }],
    ["expiresAt", { expiresAt: Number.NaN }],
  ];
  for (const [field, change] of bad) {
    const record = { ...RECORD, ...change } as PaymentRecord;
    assert.equal(isPaymentRecord(record), false, field);
    await assert.rejects(writeRecord(kv, record), new RangeError(`Beam payment record: invalid ${field}`), field);
  }
  assert.deepEqual(kv.writes, []);
  assert.equal(isPaymentRecord(RECORD), true);
});

test("recordToMeta gives the shared core's PaymentMeta, the same for the record and its verified note", () => {
  const meta = {
    ref: REF,
    reservationId: RESERVATION_ID,
    roomsSatang: 2_400_000,
    feeSatang: 72_000,
    totalSatang: 2_472_000,
    checkIn: "2027-01-10",
    checkOut: "2027-01-13",
    mode: "beam-live",
    arrivalLate: true,
    hasRequests: false,
    noteSaved: null,
    termsVersion: "2026-10-07",
  };
  assert.deepEqual(recordToMeta(RECORD), meta);
  assert.deepEqual(recordToMeta(verifyBeamNote(buildBeamNote(NOTE, TOKEN_SECRET), TOKEN_SECRET)!), meta);
});

/* ----------------------------------- note ----------------------------------- */

test("the signed note: the design's format, signed with BOOKING_TOKEN_SECRET; verifyBeamNote reads it back", () => {
  const note = buildBeamNote(NOTE, TOKEN_SECRET);
  const body =
    `msv1|m=beam-live|r=${REF}|res=${RESERVATION_ID}|rm=2400000|fee=72000|tot=2472000|ci=2027-01-10|co=2027-01-13` +
    `|pm=card_ewallet|tv=2026-10-07|fl=10-|ex=${EXPIRES}`;
  assert.equal(note, `${body}|s=${sig(body)}`);
  assert.equal(BEAM_NOTE_VERSION, "msv1");
  assert.match(note.slice(note.lastIndexOf("|s=") + 3), /^[A-Za-z0-9_-]{27}$/, "27 base64url characters");
  assert.deepEqual(verifyBeamNote(note, TOKEN_SECRET), NOTE);
  assert.equal(buildBeamNote(RECORD, TOKEN_SECRET), note, "built from the record: only the note's fields are read");

  for (const variant of [
    { ...NOTE, payMethod: "promptpay", roomsSatang: 2_400_000, feeSatang: 0, totalSatang: 2_400_000 },
    { ...NOTE, mode: "beam-playground", termsVersion: null, arrivalLate: null, hasRequests: null, noteSaved: null },
    { ...NOTE, arrivalLate: true, hasRequests: true, noteSaved: true },
    { ...NOTE, arrivalLate: false, hasRequests: false, noteSaved: false },
  ] satisfies BeamNote[]) {
    assert.deepEqual(verifyBeamNote(buildBeamNote(variant, TOKEN_SECRET), TOKEN_SECRET), variant, JSON.stringify(variant));
  }
  assert.match(buildBeamNote({ ...NOTE, termsVersion: null, arrivalLate: null, hasRequests: null, noteSaved: null }, TOKEN_SECRET), /\|tv=\|fl=---\|/);
});

test("verifyBeamNote: null after any edited field, a structural change, another secret or a damaged signature", () => {
  const note = buildBeamNote(NOTE, TOKEN_SECRET);
  const body = bodyOf(note);
  const signature = note.slice(body.length + 3);
  /** The note with one field's value replaced, keeping the original signature. */
  const edit = (field: string, value: string) => {
    const edited = body.replace(new RegExp(`\\|${field}=[^|]*`), `|${field}=${value}`);
    assert.notEqual(edited, body, field);
    return `${edited}|s=${signature}`;
  };
  // Each replacement is a well-formed value: only the signature can catch it.
  const edits: Array<[string, string]> = [
    ["m", "beam-playground"],
    ["r", "MSV-20261022-7F3L"],
    ["res", "6954439751496"],
    ["rm", "2400001"],
    ["fee", "71999"],
    ["tot", "2472001"],
    ["ci", "2027-01-11"],
    ["co", "2027-01-14"],
    ["pm", "promptpay"],
    ["tv", "2026-10-08"],
    ["tv", ""],
    ["fl", "11-"],
    ["fl", "000"],
    ["ex", String(EXPIRES + 1)],
  ];
  for (const [field, value] of edits) assert.equal(verifyBeamNote(edit(field, value), TOKEN_SECRET), null, `${field}=${value}`);
  // The amounts moved together (rooms + fee still = total): still refused.
  assert.equal(verifyBeamNote(`${body.replace("|rm=2400000|", "|rm=2300000|").replace("|tot=2472000|", "|tot=2372000|")}|s=${signature}`, TOKEN_SECRET), null);

  // Another secret, or none.
  assert.equal(verifyBeamNote(note, `${TOKEN_SECRET}x`), null);
  assert.equal(verifyBeamNote(note, ""), null);
  assert.equal(verifyBeamNote(signed(body, "another-secret-0123456789abcdefghij"), TOKEN_SECRET), null);

  // A damaged signature: one character changed, cut, padded, the full untruncated HMAC, or none.
  const flipped = `${signature.slice(0, 5)}${signature[5] === "A" ? "B" : "A"}${signature.slice(6)}`;
  const fullHmac = createHmac("sha256", TOKEN_SECRET).update(body).digest("base64url");
  for (const s of [flipped, signature.slice(0, 26), `${signature}A`, fullHmac, "", signature.toLowerCase() === signature ? signature.toUpperCase() : signature.toLowerCase()]) {
    assert.equal(verifyBeamNote(`${body}|s=${s}`, TOKEN_SECRET), null, s);
  }
  assert.equal(verifyBeamNote(body, TOKEN_SECRET), null, "no signature");

  // Whitespace or case anywhere.
  for (const changed of [` ${note}`, `${note} `, `${note}\n`, note.replace("msv1", "MSV1"), note.replace("beam-live", "Beam-live")]) {
    assert.equal(verifyBeamNote(changed, TOKEN_SECRET), null, JSON.stringify(changed));
  }

  // Correctly signed, but not a note we write: another version, an added, missing or reordered field, a
  // malformed fact. The structure is checked as well as the signature.
  const parts = body.split("|");
  for (const other of [
    body.replace(/^msv1\|/, "msv2|"),
    `${body}|x=1`,
    parts.filter((p) => !p.startsWith("tv=")).join("|"),
    [parts[0], parts[2], parts[1], ...parts.slice(3)].join("|"),
    body.replace("|tot=2472000|", "|tot=2472001|"),
    body.replace("|fl=10-|", "|fl=10|"),
    body.replace("|fl=10-|", "|fl=10x|"),
    body.replace("|rm=2400000|", "|rm=02400000|"),
    body.replace("|pm=card_ewallet|", "|pm=card|"),
    body.replace("|ci=2027-01-10|", "|ci=2027-02-30|"),
    body.replace(`|ex=${EXPIRES}`, "|ex=0"),
  ]) {
    assert.equal(verifyBeamNote(signed(other), TOKEN_SECRET), null, other);
  }
  assert.deepEqual(verifyBeamNote(signed(body), TOKEN_SECRET), NOTE, "the control: the untouched body signed the same way verifies");

  // Not a string, or longer than Beam keeps.
  for (const v of [null, undefined, 42, { note }, `${note}${"x".repeat(BEAM_NOTE_MAX_LENGTH)}`]) assert.equal(verifyBeamNote(v, TOKEN_SECRET), null);
});

test("buildBeamNote refuses a malformed fact or an empty secret", () => {
  for (const [field, change] of [
    ["mode", { mode: "beam|live" }],
    ["ref", { ref: "MSV-20261022-7F3K|x=1" }],
    ["reservationId", { reservationId: "48=21" }],
    ["totalSatang", { totalSatang: 1 }],
    ["payMethod", { payMethod: "bnpl" }],
    ["termsVersion", { termsVersion: "a|b" }],
    ["hasRequests", { hasRequests: 1 }],
    ["expiresAt", { expiresAt: -1 }],
  ] as Array<[string, Record<string, unknown>]>) {
    assert.throws(() => buildBeamNote({ ...NOTE, ...change } as BeamNote, TOKEN_SECRET), new RangeError(`Beam note: invalid ${field}`), field);
  }
  assert.throws(() => buildBeamNote(NOTE, ""), RangeError);
});

test("the longest possible note stays within Beam's 500 characters and still verifies", () => {
  const longest: BeamNote = {
    ...NOTE,
    mode: `b${"x".repeat(31)}`,
    reservationId: "R".repeat(40),
    roomsSatang: 499_999_999_999,
    feeSatang: 500_000_000_000,
    totalSatang: 999_999_999_999,
    termsVersion: "v".repeat(32),
    expiresAt: Number.MAX_SAFE_INTEGER,
  };
  const note = buildBeamNote(longest, TOKEN_SECRET);
  assert.ok(note.length <= BEAM_NOTE_MAX_LENGTH, String(note.length));
  assert.ok(note.length < 300, String(note.length));
  assert.deepEqual(verifyBeamNote(note, TOKEN_SECRET), longest);
  assert.throws(() => buildBeamNote({ ...longest, totalSatang: 1_000_000_000_000, feeSatang: 500_000_000_001 }, TOKEN_SECRET), RangeError, "past twelve digits");
});

test("the note carries no personal data: no '@', no '+', and no phone-like digit run besides the reservation id and the expiry", () => {
  const note = buildBeamNote({ ...NOTE, ...PII } as BeamNote, TOKEN_SECRET);
  assert.equal(note, buildBeamNote(NOTE, TOKEN_SECRET), "personal data a caller passes never comes along");
  assert.ok(!note.includes("@"));
  assert.ok(!note.includes("+"));
  for (const digits of ["812345678", "0812345678", "66812345678"]) assert.ok(!note.includes(digits), digits);
  // A phone number is 9 digits or more; the only such runs are the Cloudbeds reservation id and the expiry time.
  assert.deepEqual([...bodyOf(note).matchAll(/\d{9,}/g)].map((m) => m[0]), [RESERVATION_ID, String(EXPIRES)]);
  assert.ok(!/(guest|ann|call|email|phone)/i.test(bodyOf(note)));
});

/* ------------------------------ hold identifiers ------------------------------ */

test("Beam holds carry -B / -B-TEST: parseHoldIdentifier returns null for them, parseBeamHoldIdentifier reads them", () => {
  assert.equal(BEAM_HOLD_SUFFIX, "-B");
  const beam: Array<[PaymentMode, string, boolean]> = [
    ["beam-live", `${REF}-B`, true],
    ["beam-playground", `${REF}-B-TEST`, false],
  ];
  for (const [mode, id, live] of beam) {
    assert.equal(holdIdentifier(REF, mode), id, mode);
    assert.equal(parseHoldIdentifier(id), null, `${mode}: no Stripe code path (nor the pre-Beam code) ever reads a Beam hold`);
    assert.deepEqual(parseBeamHoldIdentifier(id), { ref: REF, live }, mode);
    assert.deepEqual(parseBeamHoldIdentifier(` ${id} `), { ref: REF, live }, `${mode}: trimmed like parseHoldIdentifier`);
  }
  // The Stripe modes and the demo are unchanged, and only parseHoldIdentifier reads them.
  const stripe: Array<[PaymentMode, string, boolean]> = [
    ["stripe-live", REF, true],
    ["stripe-test", `${REF}-TEST`, false],
    ["stripe-mock", `${REF}-TEST`, false],
    ["demo", `${REF}-TEST`, false],
  ];
  for (const [mode, id, live] of stripe) {
    assert.equal(holdIdentifier(REF, mode), id, mode);
    assert.deepEqual(parseHoldIdentifier(id), { ref: REF, live }, mode);
    assert.equal(parseBeamHoldIdentifier(id), null, `${mode}: a Beam run never reads a Stripe hold`);
  }
  for (const other of [
    `${REF}-B-TEST-TEST`,
    `${REF}-TEST-B`,
    `${REF}-b`,
    `${REF}-BTEST`,
    `${REF}-B-`,
    `${REF}B`,
    "MSV-1-B",
    "BDC-123",
    "",
    null,
    undefined,
  ]) {
    assert.equal(parseBeamHoldIdentifier(other), null, String(other));
    assert.equal(parseHoldIdentifier(other), null, String(other));
  }
});
