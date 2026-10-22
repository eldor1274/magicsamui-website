// Live-mode checks: the hold identifier, the TEST label on Cloudbeds writes,
// alert emails and their subject prefix and the GA4 purchase gate on the
// status answer ask payments/provider.ts isLiveMode instead of
// `=== "stripe-live"`, so a live Beam deployment gets the live answers too.
// A six-mode table; each Stripe mode must still give exactly what the old
// check gave. keyScope (and feeItemFor, for now) keep their stripe-live check.
// Beam holds carry their own tag since S2.4 ('{ref}-B' live, '{ref}-B-TEST'
// playground), which only parseBeamHoldIdentifier reads.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { alertEmailEnabled, alertSubjectPrefix } from "./alerts.ts";
import type { BookingConfig } from "./config.ts";
import { testMoneyLabel } from "./fulfil.ts";
import { holdIdentifier, keyScope, parseBeamHoldIdentifier, parseHoldIdentifier } from "./lock.ts";
import { isLiveMode, providerOf } from "./payments/provider.ts";
import { purchaseFor } from "./status.ts";
import type { BookingSummary, FulfilmentView, PaymentMode } from "./types.ts";

const REF = "MSV-20261005-ABCD";
const TEST_LABEL = "TEST MODE - NOT REAL MONEY. ";

interface Row {
  mode: PaymentMode;
  live: boolean;
  identifier: string;
  label: string;
  /** alertEmailEnabled without BOOKING_ALERTS_IN_TEST. */
  email: boolean;
  prefix: string;
}

const TABLE: Row[] = [
  { mode: "demo", live: false, identifier: `${REF}-TEST`, label: TEST_LABEL, email: false, prefix: "[demo] " },
  { mode: "beam-playground", live: false, identifier: `${REF}-B-TEST`, label: TEST_LABEL, email: false, prefix: "[beam-playground] " },
  { mode: "beam-live", live: true, identifier: `${REF}-B`, label: "", email: true, prefix: "" },
  { mode: "stripe-mock", live: false, identifier: `${REF}-TEST`, label: TEST_LABEL, email: false, prefix: "[stripe-mock] " },
  { mode: "stripe-test", live: false, identifier: `${REF}-TEST`, label: TEST_LABEL, email: false, prefix: "[stripe-test] " },
  { mode: "stripe-live", live: true, identifier: REF, label: "", email: true, prefix: "" },
];

/** Only paymentMode is read by these checks. */
const configOf = (mode: PaymentMode, production = true) => ({ paymentMode: mode, production }) as BookingConfig;

function booking(mode: PaymentMode): BookingSummary {
  return {
    ref: REF,
    paymentMode: mode,
    checkIn: "2026-11-02",
    checkOut: "2026-11-05",
    nights: 3,
    items: [{ slug: "honeymoon-suite", ratePlanId: "standard", adults: 2, addonIds: [] }],
    itemRoomSatang: [1_800_000],
    promoCode: null,
    totalSatang: 1_890_000,
    cardFeeSatang: 90_000,
    dueNowSatang: 1_890_000,
    createdAt: "2026-10-05T03:00:00.000Z",
    linkExpiresAt: "2026-10-05T03:30:00.000Z",
  };
}

const CONFIRMED: FulfilmentView = { state: "confirmed", reservationId: "48213377" };

test("the table covers every payment mode once, and isLiveMode is true for exactly beam-live and stripe-live", () => {
  assert.deepEqual(
    TABLE.map((r) => r.mode),
    ["demo", "beam-playground", "beam-live", "stripe-mock", "stripe-test", "stripe-live"],
  );
  for (const r of TABLE) assert.equal(isLiveMode(r.mode), r.live, r.mode);
});

test("holdIdentifier: the plain ref in a live mode, -TEST otherwise; Beam holds -B / -B-TEST (and parseHoldIdentifier, for Beam parseBeamHoldIdentifier, reads it back)", () => {
  for (const r of TABLE) {
    assert.equal(holdIdentifier(REF, r.mode), r.identifier, r.mode);
    const parse = providerOf(r.mode) === "beam" ? parseBeamHoldIdentifier : parseHoldIdentifier;
    assert.deepEqual(parse(holdIdentifier(REF, r.mode)), { ref: REF, live: r.live }, r.mode);
  }
});

test("testMoneyLabel: no TEST label on Cloudbeds writes in a live mode, the label in every other mode", () => {
  for (const r of TABLE) assert.equal(testMoneyLabel({ config: configOf(r.mode) }), r.label, r.mode);
});

test("alert emails: on in a live mode, otherwise only with BOOKING_ALERTS_IN_TEST=true; no subject prefix in a live mode", () => {
  for (const r of TABLE) {
    assert.equal(alertEmailEnabled(r.mode, {}), r.email, r.mode);
    assert.equal(alertEmailEnabled(r.mode, { BOOKING_ALERTS_IN_TEST: "true" }), true, r.mode);
    assert.equal(alertEmailEnabled(r.mode, { BOOKING_ALERTS_IN_TEST: "1" }), r.email, `${r.mode}: only the exact value "true"`);
    assert.equal(alertSubjectPrefix(r.mode), r.prefix, r.mode);
  }
});

test("purchase gate: a live mode on the production deployment, with the Cloudbeds reservation confirmed", () => {
  for (const r of TABLE) {
    const b = booking(r.mode);
    const expected = r.live ? { transactionId: "48213377", valueBaht: 18_900, currency: "THB" } : null;
    assert.deepEqual(purchaseFor(configOf(r.mode), b, CONFIRMED), expected, r.mode);
    assert.equal(purchaseFor(configOf(r.mode, false), b, CONFIRMED), null, `${r.mode}: not on a preview deployment`);
    for (const fulfilment of [
      { state: "confirming", reservationId: null },
      { state: "needs_attention", reservationId: "48213377" },
      { state: "confirmed", reservationId: null },
    ] satisfies FulfilmentView[]) {
      assert.equal(purchaseFor(configOf(r.mode), b, fulfilment), null, `${r.mode}: ${fulfilment.state}`);
    }
  }
});

test("Stripe modes answer exactly what the old `=== \"stripe-live\"` checks answered", () => {
  for (const r of TABLE.filter((row) => providerOf(row.mode) === "stripe")) {
    const old = r.mode === "stripe-live";
    assert.equal(holdIdentifier(REF, r.mode), old ? REF : `${REF}-TEST`, r.mode);
    assert.equal(testMoneyLabel({ config: configOf(r.mode) }), old ? "" : TEST_LABEL, r.mode);
    assert.equal(alertEmailEnabled(r.mode, {}), old, r.mode);
    assert.equal(alertSubjectPrefix(r.mode), old ? "" : `[${r.mode}] `, r.mode);
    assert.equal(purchaseFor(configOf(r.mode), booking(r.mode), CONFIRMED) !== null, old, r.mode);
  }
});

test("keyScope is unchanged: only stripe-live shares the \"live\" scope, beam-live keeps its own", () => {
  assert.deepEqual(
    TABLE.map((r) => keyScope(r.mode)),
    ["demo", "beam-playground", "beam-live", "stripe-mock", "stripe-test", "live"],
  );
});

test("production wiring: runtime.ts builds the alerter from alertEmailEnabled and alertSubjectPrefix", () => {
  // runtime.ts imports next/server, so plain Node tests can't call alerterFor itself.
  const rt = readFileSync(new URL("./runtime.ts", import.meta.url), "utf8");
  assert.match(rt, /emailEnabled: alertEmailEnabled\(config\.paymentMode, process\.env\),/);
  assert.match(rt, /subjectPrefix: alertSubjectPrefix\(config\.paymentMode\),/);
});
