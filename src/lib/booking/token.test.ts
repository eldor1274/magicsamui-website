import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createBookingToken,
  createDemoProof,
  generateBookingRef,
  idempotencyKeyFor,
  isBookingRef,
  verifyBookingToken,
  verifyDemoProof,
} from "./token.ts";
import type { BookingSummary } from "./types.ts";

const SECRET = "test-secret-0123456789abcdefghijklmnop";
const NOW = Date.parse("2026-10-05T03:00:00Z");

const booking: BookingSummary = {
  ref: "MSV-20261005-7F3K",
  paymentMode: "demo",
  checkIn: "2026-10-28",
  checkOut: "2026-10-31",
  nights: 3,
  items: [{ slug: "sunrise-suite", ratePlanId: "standard", adults: 2, addonIds: [] }],
  itemRoomSatang: [1_395_000],
  promoCode: null,
  totalSatang: 1_464_750,
  cardFeeSatang: 69_750,
  dueNowSatang: 1_464_750,
  createdAt: "2026-10-05T03:00:00.000Z",
  linkExpiresAt: "2026-10-05T03:30:00.000Z",
};

test("booking token round-trips", () => {
  const t = createBookingToken(booking, "plink_1", SECRET, 3600, NOW);
  const v = verifyBookingToken(t, SECRET, NOW + 1000);
  assert.equal(v.ok, true);
  if (v.ok) {
    assert.deepEqual(v.payload.booking, booking);
    assert.equal(v.payload.paymentLinkId, "plink_1");
  }
});

test("token carries no personal data fields", () => {
  const t = createBookingToken(booking, null, SECRET, 3600, NOW);
  const json = Buffer.from(t.split(".")[0], "base64url").toString("utf8");
  assert.doesNotMatch(json, /email|phone|firstName|lastName|@/i);
});

test("expired, tampered, wrong-secret and wrong-kind tokens are rejected", () => {
  const t = createBookingToken(booking, null, SECRET, 60, NOW);
  assert.deepEqual(verifyBookingToken(t, SECRET, NOW + 61_000), { ok: false, reason: "expired" });

  const [payload, sig] = t.split(".");
  const tampered = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  tampered.booking.dueNowSatang = 100;
  const forged = `${Buffer.from(JSON.stringify(tampered)).toString("base64url")}.${sig}`;
  assert.deepEqual(verifyBookingToken(forged, SECRET, NOW), { ok: false, reason: "bad_signature" });

  assert.deepEqual(verifyBookingToken(t, "another-secret-0123456789abcdefghij", NOW), { ok: false, reason: "bad_signature" });
  assert.deepEqual(verifyBookingToken("not-a-token", SECRET, NOW), { ok: false, reason: "malformed" });
  assert.deepEqual(verifyBookingToken(undefined, SECRET, NOW), { ok: false, reason: "malformed" });

  const proof = createDemoProof(booking.ref, "paid", null, SECRET, 60, NOW);
  assert.deepEqual(verifyBookingToken(proof, SECRET, NOW), { ok: false, reason: "wrong_kind" });
  assert.equal(verifyDemoProof(proof, SECRET, NOW).ok, true);
  assert.deepEqual(verifyDemoProof(t, SECRET, NOW), { ok: false, reason: "wrong_kind" });
});

test("booking refs look like MSV-YYYYMMDD-XXXX", () => {
  const ref = generateBookingRef("2026-10-05");
  assert.equal(isBookingRef(ref), true, ref);
  assert.match(ref, /^MSV-20261005-/);
  let i = 0;
  assert.equal(generateBookingRef("2026-10-05", () => i++ % 32), "MSV-20261005-ABCD");
});

test("idempotency key is a stable UUID v4 per booking and mode", () => {
  const a = idempotencyKeyFor("MSV-20261005-7F3K", "beam-playground");
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(a, idempotencyKeyFor("MSV-20261005-7F3K", "beam-playground"));
  assert.notEqual(a, idempotencyKeyFor("MSV-20261005-7F3L", "beam-playground"));
  assert.notEqual(a, idempotencyKeyFor("MSV-20261005-7F3K", "beam-live"));
});
