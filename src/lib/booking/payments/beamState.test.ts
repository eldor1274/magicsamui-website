// beamPaymentState (S2.3): a table over every link status x charge set at two
// moments (inside the link's life, and after expiry + skew + grace), the skew,
// grace and 24-hour boundaries, the rule order, and the real beam.ts client
// reading the in-repo fake Beam into it (Bangkok +07:00 timestamps).

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPaymentLinkRequest, createPaymentLink, disablePaymentLink, getPaymentLink, listPaymentLinkCharges } from "../beam.ts";
import type { BeamCharge, BeamChargeStatus, BeamMethodGroup, BeamPaymentLink } from "../beam.ts";
import { bangkokTime, createFakeBeam } from "../mock/fakeBeam.ts";
import type { FakeBeamOptions } from "../mock/fakeBeam.ts";
import type { Quote, QuoteLine } from "../types.ts";
import { BEAM_EXPIRY_SKEW_MS, BEAM_PENDING_BLOCK_MS, beamPaymentState } from "./beamState.ts";
import type { BeamPaymentState, BeamStateOptions } from "./beamState.ts";

const MIN = 60_000;
const T0 = Date.parse("2026-10-22T03:00:00Z");
const EXPIRES = T0 + 30 * MIN;
const GRACE = 20 * MIN;
const LINK_ID = "rGtqz6DafS";
const OTHER_LINK_ID = "HFF4n25LYl";
const NET = 2_472_000;
const REF = "MSV-20261022-7F3K";

/** Inside the link's life (before expiresAt). */
const DURING = T0 + 10 * MIN;
/** After expiresAt + skew and after expiresAt + grace. */
const LATE = EXPIRES + GRACE + MIN;

function link(status: string, extra: Partial<BeamPaymentLink> = {}): BeamPaymentLink {
  return {
    paymentLinkId: LINK_ID,
    merchantId: "m_FakeBeamMerchant0000000000",
    status: status as BeamPaymentLink["status"],
    order: { netAmount: NET, currency: "THB", referenceId: REF },
    expiresAt: bangkokTime(EXPIRES),
    ...extra,
  };
}

let seq = 0;
function charge(status: string, extra: Partial<BeamCharge> = {}): BeamCharge {
  seq++;
  return {
    chargeId: `ch_${String(seq).padStart(27, "0")}`,
    referenceId: REF,
    status: status as BeamChargeStatus,
    amount: NET,
    currency: "THB",
    source: "PAYMENT_LINK",
    sourceId: LINK_ID,
    createdAt: bangkokTime(T0 + 5 * MIN),
    ...extra,
  };
}

function run(l: BeamPaymentLink, charges: BeamCharge[], nowMs: number, extra: Partial<BeamStateOptions> = {}): BeamPaymentState {
  return beamPaymentState(l, charges, { nowMs, graceMs: GRACE, ...extra });
}

/** "state[/pendingReason][+disable][!mismatch][!ambiguous]" (!ambiguous: refundAmbiguous) */
function code(s: BeamPaymentState): string {
  return `${s.state}${s.pendingReason ? `/${s.pendingReason}` : ""}${s.needsDisable ? "+disable" : ""}${s.mismatch ? "!mismatch" : ""}${
    s.refundAmbiguous ? "!ambiguous" : ""
  }`;
}

type SetName =
  | "none"
  | "failed"
  | "pending"
  | "failed+pending"
  | "succeeded"
  | "two succeeded"
  | "wrong amount"
  | "foreign"
  | "unknown status";

const SETS: SetName[] = ["none", "failed", "pending", "failed+pending", "succeeded", "two succeeded", "wrong amount", "foreign", "unknown status"];

/** Each set in Beam's listing order (newest first). */
function chargeSet(name: SetName): BeamCharge[] {
  switch (name) {
    case "none":
      return [];
    case "failed":
      return [charge("FAILED", { failureCode: "CH_CARD_DECLINED" })];
    case "pending":
      return [charge("PENDING")];
    case "failed+pending":
      return [charge("PENDING", { createdAt: bangkokTime(T0 + 7 * MIN) }), charge("FAILED", { createdAt: bangkokTime(T0 + 4 * MIN) })];
    case "succeeded":
      return [charge("SUCCEEDED")];
    case "two succeeded":
      return [charge("SUCCEEDED", { createdAt: bangkokTime(T0 + 8 * MIN) }), charge("SUCCEEDED", { createdAt: bangkokTime(T0 + 3 * MIN) })];
    case "wrong amount":
      return [charge("SUCCEEDED", { amount: NET - 100 })];
    case "foreign":
      // Another link's charges, and a charge naming this link from another source: none of them count.
      return [
        charge("SUCCEEDED", { sourceId: OTHER_LINK_ID }),
        charge("SUCCEEDED", { source: "QR_PROMPT_PAY_LINK" }),
        charge("PENDING", { source: undefined }),
        charge("SUCCEEDED", { sourceId: undefined }),
      ];
    case "unknown status":
      return [charge("CANCELLED")];
  }
}

const STATUSES = ["ACTIVE", "PAID", "EXPIRED", "DISABLED", "VOIDED", "REFUNDED", "ARCHIVED", "", "paid"] as const;

// [during, late] for every link status x charge set.
const CLOSED: Record<SetName, [string, string]> = {
  none: ["expired", "expired"],
  failed: ["expired", "expired"],
  pending: ["processing/processing", "expired/unconfirmed"],
  "failed+pending": ["processing/processing", "expired/unconfirmed"],
  succeeded: ["paid", "paid"],
  "two succeeded": ["paid", "paid"],
  "wrong amount": ["paid!mismatch", "paid!mismatch"],
  foreign: ["expired", "expired"],
  "unknown status": ["processing", "processing"],
};
const REFUNDED: Record<SetName, [string, string]> = {
  none: ["refunded", "refunded"],
  failed: ["refunded", "refunded"],
  pending: ["refunded", "refunded"],
  "failed+pending": ["refunded", "refunded"],
  succeeded: ["refunded", "refunded"],
  // Which of the two was refunded is unknown: never 'refunded' (round-1 review issue 0), a CRITICAL instead.
  "two succeeded": ["paid!mismatch!ambiguous", "paid!mismatch!ambiguous"],
  "wrong amount": ["refunded!mismatch", "refunded!mismatch"],
  foreign: ["refunded", "refunded"],
  "unknown status": ["refunded", "refunded"],
};
const UNKNOWN: Record<SetName, [string, string]> = {
  none: ["processing", "processing"],
  failed: ["processing", "processing"],
  pending: ["processing", "processing"],
  "failed+pending": ["processing", "processing"],
  succeeded: ["paid", "paid"],
  "two succeeded": ["paid", "paid"],
  "wrong amount": ["paid!mismatch", "paid!mismatch"],
  foreign: ["processing", "processing"],
  "unknown status": ["processing", "processing"],
};
const TABLE: Record<(typeof STATUSES)[number], Record<SetName, [string, string]>> = {
  ACTIVE: {
    none: ["open", "open+disable"],
    failed: ["open", "open+disable"],
    pending: ["processing/processing", "processing/processing+disable"],
    "failed+pending": ["processing/processing", "processing/processing+disable"],
    succeeded: ["paid", "paid"],
    "two succeeded": ["paid", "paid"],
    "wrong amount": ["paid!mismatch", "paid!mismatch"],
    foreign: ["open", "open+disable"],
    "unknown status": ["processing", "processing+disable"],
  },
  PAID: {
    none: ["paid", "paid"],
    failed: ["paid", "paid"],
    pending: ["paid", "paid"],
    "failed+pending": ["paid", "paid"],
    succeeded: ["paid", "paid"],
    "two succeeded": ["paid", "paid"],
    "wrong amount": ["paid!mismatch", "paid!mismatch"],
    foreign: ["paid", "paid"],
    "unknown status": ["paid", "paid"],
  },
  EXPIRED: CLOSED,
  DISABLED: CLOSED,
  VOIDED: REFUNDED,
  REFUNDED: REFUNDED,
  ARCHIVED: UNKNOWN,
  "": UNKNOWN,
  paid: UNKNOWN,
};

test("table: every link status x charge set, inside the link's life and after expiry + skew + grace", () => {
  for (const status of STATUSES) {
    for (const set of SETS) {
      const [during, late] = TABLE[status][set];
      for (const [label, nowMs, want] of [
        ["during", DURING, during],
        ["late", LATE, late],
      ] as const) {
        const charges = chargeSet(set);
        const s = run(link(status), charges, nowMs);
        const where = `${JSON.stringify(status)} x ${set} (${label})`;
        assert.equal(code(s), want, where);
        assert.notEqual(s.state, "failed", `${where}: 'failed' is never answered`);

        // The charge lists follow the set, whatever the state.
        const own = set === "foreign" ? [] : charges;
        const byStatus = (st: string) => own.filter((c) => c.status === st).reverse();
        assert.deepEqual(s.succeeded, byStatus("SUCCEEDED"), `${where}: succeeded, in the order they succeeded`);
        assert.deepEqual(s.pending, byStatus("PENDING"), `${where}: pending, oldest first`);
        assert.equal(s.primary, s.succeeded[0] ?? null, `${where}: primary = the first to succeed`);
        assert.equal(s.refundAmbiguous === true, (status === "VOIDED" || status === "REFUNDED") && s.succeeded.length >= 2, `${where}: refundAmbiguous`);
        assert.equal(s.attempted, own.length > 0, `${where}: attempted = any charge of this link`);

        // Amount and currency: the primary charge's when there is one, else the link order's.
        assert.equal(s.amountSatang, s.primary ? s.primary.amount : NET, `${where}: amount`);
        assert.equal(s.currency, "THB", `${where}: currency`);
      }
    }
  }
});

test("PAID with no SUCCEEDED charge listed: paid at the order's amount, charge id pending (gap review 2, money review 7)", () => {
  for (const charges of [[], [charge("PENDING")], [charge("FAILED")]]) {
    const s = run(link("PAID"), charges, DURING);
    assert.equal(s.state, "paid");
    assert.equal(s.primary, null);
    assert.deepEqual(s.succeeded, []);
    assert.equal(s.amountSatang, NET);
    assert.equal(s.currency, "THB");
    assert.equal(s.mismatch, undefined);
    assert.equal(s.needsDisable, false);
    assert.equal(s.pendingReason, undefined);
  }
});

test("two SUCCEEDED charges: both listed in the order they succeeded, the first to succeed is primary (money review 3)", () => {
  // Without a transactionTime, createdAt decides.
  const newer = charge("SUCCEEDED", { createdAt: bangkokTime(T0 + 9 * MIN), paymentMethod: { paymentMethodType: "CARD" } });
  const older = charge("SUCCEEDED", { createdAt: bangkokTime(T0 + 2 * MIN), paymentMethod: { paymentMethodType: "QR_PROMPT_PAY" } });
  for (const status of ["ACTIVE", "PAID", "EXPIRED", "DISABLED"]) {
    const s = run(link(status), [newer, older], LATE);
    assert.equal(s.state, "paid", status);
    assert.deepEqual(s.succeeded, [older, newer], status);
    assert.equal(s.primary, older, status);
    assert.equal(s.mismatch, undefined, status);
  }

  // The late confirmation (round-1 review issue 1): a QR attempt begun first confirms only after the card paid.
  // The card stays primary: it is the payment that paid the booking (amount, currency and method come from it).
  const qr = charge("SUCCEEDED", {
    createdAt: bangkokTime(T0 + MIN),
    transactionTime: bangkokTime(T0 + 12 * MIN),
    paymentMethod: { paymentMethodType: "QR_PROMPT_PAY" },
    amount: NET - 72_000,
  });
  const card = charge("SUCCEEDED", { createdAt: bangkokTime(T0 + 4 * MIN), transactionTime: bangkokTime(T0 + 5 * MIN), paymentMethod: { paymentMethodType: "CARD" } });
  for (const list of [
    [qr, card],
    [card, qr],
  ]) {
    const s = run(link("PAID"), list, LATE);
    assert.equal(s.primary, card);
    assert.deepEqual(s.succeeded, [card, qr]);
    assert.equal(s.amountSatang, NET);
    assert.equal(s.mismatch, undefined, "the late QR's own amount is not the booking's answer");
    assert.deepEqual(s.pending, []);
  }
  // transactionTime across offsets; a charge without a readable transactionTime falls back to its createdAt.
  const zulu = charge("SUCCEEDED", { createdAt: bangkokTime(T0), transactionTime: "2026-10-22T03:07:00Z" }); // 10:07+07:00
  const bkk = charge("SUCCEEDED", { createdAt: bangkokTime(T0), transactionTime: "2026-10-22T10:06:00+07:00" });
  const undated = charge("SUCCEEDED", { createdAt: bangkokTime(T0 + 6 * MIN + 30_000), transactionTime: "2026-10-22T10:05:00" });
  assert.deepEqual(run(link("PAID"), [zulu, bkk, undated], LATE).succeeded, [bkk, undated, zulu]);
  // Equal success times keep the createdAt order, then Beam's listing order reversed.
  const same = bangkokTime(T0 + 8 * MIN);
  const a = charge("SUCCEEDED", { createdAt: bangkokTime(T0 + 3 * MIN), transactionTime: same });
  const b = charge("SUCCEEDED", { createdAt: bangkokTime(T0 + 2 * MIN), transactionTime: same });
  const c = charge("SUCCEEDED", { createdAt: bangkokTime(T0 + 2 * MIN), transactionTime: same });
  assert.deepEqual(run(link("PAID"), [a, b, c], LATE).succeeded, [c, b, a]);
  // Neither time readable: such a charge succeeded last.
  const blind = charge("SUCCEEDED", { createdAt: undefined, transactionTime: undefined });
  assert.deepEqual(run(link("PAID"), [blind, a], LATE).succeeded, [a, blind]);
});

test("rule 1 with two or more SUCCEEDED charges: never 'refunded', but 'paid' with refundAmbiguous and a mismatch for the owner", () => {
  const first = charge("SUCCEEDED", { createdAt: bangkokTime(T0 + 2 * MIN) });
  const second = charge("SUCCEEDED", { createdAt: bangkokTime(T0 + 7 * MIN), paymentMethod: { paymentMethodType: "ALIPAY" } });
  for (const status of ["VOIDED", "REFUNDED"]) {
    for (const nowMs of [DURING, LATE, LATE + 30 * BEAM_PENDING_BLOCK_MS]) {
      const s = run(link(status), [second, first], nowMs);
      assert.equal(code(s), "paid!mismatch!ambiguous", status);
      assert.equal(s.refundAmbiguous, true);
      assert.equal(s.primary, first);
      assert.deepEqual(s.succeeded, [first, second]);
      assert.equal(s.amountSatang, NET);
      assert.equal(s.needsDisable, false);
      assert.equal(
        s.mismatch,
        `Beam payment link ${LINK_ID} is ${status} but has 2 SUCCEEDED charges (${first.chargeId}, ${second.chargeId}): check in Lighthouse which charges were refunded`,
      );
    }
  }
  // Three, one of them for the wrong amount: both problems are named, the ambiguity first.
  const third = charge("SUCCEEDED", { createdAt: bangkokTime(T0 + MIN), amount: NET - 1 });
  const s = run(link("REFUNDED"), [second, first, third], DURING);
  assert.equal(s.primary, third);
  assert.equal(s.amountSatang, NET - 1);
  assert.match(s.mismatch ?? "", /^Beam payment link \S+ is REFUNDED but has 3 SUCCEEDED charges \(.+\): check in Lighthouse which charges were refunded\. Beam charge \S+ on payment link \S+: amount 2471999 does not match the link's netAmount 2472000$/);
  // Charges without an id cannot be told apart: two of them are two charges.
  assert.equal(code(run(link("REFUNDED"), [charge("SUCCEEDED", { chargeId: "" }), charge("SUCCEEDED", { chargeId: "" })], DURING)), "paid!mismatch!ambiguous");
  // The same charge listed twice is one charge: plainly refunded.
  const once = charge("SUCCEEDED");
  assert.equal(code(run(link("REFUNDED"), [once, { ...once }], DURING)), "refunded");
  // One SUCCEEDED charge next to PENDING or FAILED ones is still refunded (until a second one succeeds).
  assert.equal(code(run(link("REFUNDED"), [charge("PENDING"), first, charge("FAILED")], LATE)), "refunded");
  assert.equal(run(link("REFUNDED"), [first], LATE).refundAmbiguous, undefined);
});

test("fallbackExpiresAtMs: the expiry we set at create time stands in when Beam's expiresAt cannot be read", () => {
  const fallbackExpiresAtMs = EXPIRES;
  for (const expiresAt of [undefined, "", "2026-10-22T10:30:00"]) {
    const where = String(expiresAt);
    // ACTIVE: disabled by us at the fallback + skew.
    assert.equal(code(run(link("ACTIVE", { expiresAt }), [], EXPIRES + BEAM_EXPIRY_SKEW_MS - 1, { fallbackExpiresAtMs })), "open", where);
    assert.equal(code(run(link("ACTIVE", { expiresAt }), [], EXPIRES + BEAM_EXPIRY_SKEW_MS, { fallbackExpiresAtMs })), "open+disable", where);
    assert.equal(code(run(link("ACTIVE", { expiresAt }), [charge("PENDING")], LATE, { fallbackExpiresAtMs })), "processing/processing+disable", where);
    // EXPIRED or DISABLED with a PENDING charge: the grace and the 24 hours are measured from the fallback.
    for (const status of ["EXPIRED", "DISABLED"]) {
      const l = link(status, { expiresAt });
      assert.equal(code(run(l, [charge("PENDING")], EXPIRES + GRACE - 1, { fallbackExpiresAtMs })), "processing/processing", where);
      assert.equal(code(run(l, [charge("PENDING")], EXPIRES + GRACE, { fallbackExpiresAtMs })), "expired/unconfirmed", where);
      const undated = [charge("PENDING", { createdAt: undefined })];
      assert.equal(code(run(l, undated, EXPIRES + BEAM_PENDING_BLOCK_MS, { fallbackExpiresAtMs })), "expired", `${where}: aged from the fallback`);
      // Without the fallback it stays processing, as before.
      assert.equal(code(run(l, [charge("PENDING")], LATE + 30 * BEAM_PENDING_BLOCK_MS)), "processing/processing", where);
    }
  }
  // Beam's own readable expiresAt wins over the fallback.
  assert.equal(code(run(link("ACTIVE"), [], EXPIRES + BEAM_EXPIRY_SKEW_MS, { fallbackExpiresAtMs: EXPIRES + 60 * MIN })), "open+disable");
  assert.equal(code(run(link("EXPIRED"), [charge("PENDING")], EXPIRES + GRACE, { fallbackExpiresAtMs: EXPIRES + 60 * MIN })), "expired/unconfirmed");
  // It must be a finite time.
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, "x" as unknown as number]) {
    assert.throws(() => run(link("ACTIVE", { expiresAt: undefined }), [], DURING, { fallbackExpiresAtMs: bad }), RangeError);
  }
});

test("a wrong-amount or non-THB SUCCEEDED charge is paid with a mismatch; the amount is the charge's, as Beam reports it", () => {
  const wrong = charge("SUCCEEDED", { amount: NET + 1 });
  let s = run(link("PAID"), [wrong], DURING);
  assert.equal(s.state, "paid");
  assert.equal(s.amountSatang, NET + 1);
  assert.match(s.mismatch ?? "", new RegExp(`^Beam charge ${wrong.chargeId} on payment link ${LINK_ID}: amount ${NET + 1} does not match the link's netAmount ${NET}$`));

  s = run(link("PAID"), [charge("SUCCEEDED", { currency: "USD" })], DURING);
  assert.equal(s.currency, "USD");
  assert.match(s.mismatch ?? "", /currency USD is not THB$/);

  s = run(link("PAID"), [charge("SUCCEEDED", { currency: "thb" })], DURING);
  assert.equal(s.mismatch, undefined, "the currency compares without case");
  assert.equal(s.currency, "thb", "and is reported as Beam wrote it");

  s = run(link("PAID"), [charge("SUCCEEDED", { amount: Number.NaN, currency: "" })], DURING);
  assert.equal(s.amountSatang, null);
  assert.match(s.mismatch ?? "", /amount unknown does not match the link's netAmount 2472000; currency unknown is not THB$/);

  // A link answer without a readable order: the charge cannot be checked against it.
  s = run({ ...link("PAID"), order: undefined as unknown as BeamPaymentLink["order"] }, [charge("SUCCEEDED")], DURING);
  assert.equal(s.state, "paid");
  assert.equal(s.amountSatang, NET);
  assert.match(s.mismatch ?? "", /does not match the link's netAmount unknown$/);

  // ... and a PAID one with no charge has no amount at all (fulfil's amount check then refuses it).
  s = run({ ...link("PAID"), order: undefined as unknown as BeamPaymentLink["order"] }, [], DURING);
  assert.equal(s.state, "paid");
  assert.equal(s.amountSatang, null);
  assert.equal(s.currency, null);

  // The mismatch names ids and amounts only.
  s = run(link("PAID", { order: { netAmount: NET, currency: "THB", referenceId: REF, internalNote: "msv1|r=x" } }), [wrong], DURING);
  assert.doesNotMatch(s.mismatch ?? "", /msv1|MSV-|@/);
});

test("skew boundary: an ACTIVE link needs disabling at expiresAt + skew, not a millisecond before", () => {
  assert.equal(BEAM_EXPIRY_SKEW_MS, 120_000);
  for (const charges of [[], [charge("PENDING")], [charge("FAILED")]]) {
    assert.equal(run(link("ACTIVE"), charges, EXPIRES).needsDisable, false, "at expiresAt");
    assert.equal(run(link("ACTIVE"), charges, EXPIRES + BEAM_EXPIRY_SKEW_MS - 1).needsDisable, false, "1 ms before expiresAt + skew");
    assert.equal(run(link("ACTIVE"), charges, EXPIRES + BEAM_EXPIRY_SKEW_MS).needsDisable, true, "at expiresAt + skew");
  }
  // The answer itself does not change with the skew.
  assert.equal(code(run(link("ACTIVE"), [charge("PENDING")], EXPIRES + BEAM_EXPIRY_SKEW_MS)), "processing/processing+disable");
  assert.equal(code(run(link("ACTIVE"), [], EXPIRES + BEAM_EXPIRY_SKEW_MS)), "open+disable");
  // A custom skew.
  assert.equal(run(link("ACTIVE"), [], EXPIRES + 4_999, { skewMs: 5_000 }).needsDisable, false);
  assert.equal(run(link("ACTIVE"), [], EXPIRES + 5_000, { skewMs: 5_000 }).needsDisable, true);
  // Only ACTIVE links are disabled by us.
  for (const status of ["PAID", "EXPIRED", "DISABLED", "VOIDED", "REFUNDED", "ARCHIVED"]) {
    assert.equal(run(link(status), [charge("PENDING")], LATE + BEAM_PENDING_BLOCK_MS).needsDisable, false, status);
  }
  // An ACTIVE link with no readable expiresAt is never disabled by us.
  assert.equal(run(link("ACTIVE", { expiresAt: undefined }), [], LATE).needsDisable, false);
  assert.equal(run(link("ACTIVE", { expiresAt: "2026-10-22T10:30:00" }), [], LATE).needsDisable, false, "a time without a zone is not read");
});

test("grace boundary: a PENDING charge on an EXPIRED or DISABLED link is processing until expiresAt + grace", () => {
  for (const status of ["EXPIRED", "DISABLED"]) {
    const pending = [charge("PENDING")];
    assert.equal(code(run(link(status), pending, EXPIRES + GRACE - 1)), "processing/processing", `${status}: 1 ms before`);
    assert.equal(code(run(link(status), pending, EXPIRES + GRACE)), "expired/unconfirmed", `${status}: at expiresAt + grace`);
    // The grace is the caller's (BEAM_PENDING_GRACE_MINUTES).
    assert.equal(code(run(link(status), pending, EXPIRES + 5 * MIN - 1, { graceMs: 5 * MIN })), "processing/processing");
    assert.equal(code(run(link(status), pending, EXPIRES + 5 * MIN, { graceMs: 5 * MIN })), "expired/unconfirmed");
    assert.equal(code(run(link(status), pending, EXPIRES, { graceMs: 0 })), "expired/unconfirmed", "no grace");
    // Without a PENDING charge the grace plays no part.
    assert.equal(code(run(link(status), [charge("FAILED")], EXPIRES - MIN)), "expired");
  }
  // A link disabled early (the guest left) is measured from its expiresAt, not from when it closed.
  assert.equal(code(run(link("DISABLED"), [charge("PENDING")], T0 + 6 * MIN)), "processing/processing");
});

test("24-hour boundary: after the grace a PENDING charge answers 'unconfirmed' until it is pendingBlockMs old (money review 8)", () => {
  assert.equal(BEAM_PENDING_BLOCK_MS, 24 * 60 * MIN);
  const createdMs = T0 + 5 * MIN;
  const pending = [charge("PENDING", { createdAt: bangkokTime(createdMs) })];
  for (const status of ["EXPIRED", "DISABLED"]) {
    assert.equal(code(run(link(status), pending, createdMs + BEAM_PENDING_BLOCK_MS - 1)), "expired/unconfirmed", status);
    assert.equal(code(run(link(status), pending, createdMs + BEAM_PENDING_BLOCK_MS)), "expired", status);
    // A custom block (30 minutes from createdAt = 5 minutes past expiresAt, after a zero grace).
    assert.equal(code(run(link(status), pending, createdMs + 30 * MIN, { pendingBlockMs: 30 * MIN, graceMs: 0 })), "expired");
    assert.equal(code(run(link(status), pending, createdMs + 30 * MIN - 1, { pendingBlockMs: 30 * MIN, graceMs: 0 })), "expired/unconfirmed");
    // A block shorter than the grace never shows 'unconfirmed': the grace answers 'processing' first, then plain 'expired'.
    assert.equal(code(run(link(status), pending, EXPIRES + GRACE - 1, { pendingBlockMs: MIN })), "processing/processing");
    assert.equal(code(run(link(status), pending, EXPIRES + GRACE, { pendingBlockMs: MIN })), "expired");
  }
  // The YOUNGEST pending charge decides.
  const two = [charge("PENDING", { createdAt: bangkokTime(T0 + 25 * MIN) }), charge("PENDING", { createdAt: bangkokTime(T0 + MIN) })];
  assert.equal(code(run(link("EXPIRED"), two, T0 + MIN + BEAM_PENDING_BLOCK_MS)), "expired/unconfirmed");
  assert.equal(code(run(link("EXPIRED"), two, T0 + 25 * MIN + BEAM_PENDING_BLOCK_MS)), "expired");
  // A pending charge without a readable createdAt is aged from expiresAt (it was begun before the link closed).
  const undated = [charge("PENDING", { createdAt: undefined })];
  assert.equal(code(run(link("EXPIRED"), undated, EXPIRES + BEAM_PENDING_BLOCK_MS - 1)), "expired/unconfirmed");
  assert.equal(code(run(link("EXPIRED"), undated, EXPIRES + BEAM_PENDING_BLOCK_MS)), "expired");
  // Long after, the charge is still listed for the late watch.
  const s = run(link("EXPIRED"), pending, createdMs + 7 * BEAM_PENDING_BLOCK_MS);
  assert.deepEqual(s.pending, pending);
  assert.equal(s.attempted, true);
});

test("rule order: refunded before paid, paid before the grace rules and the disable, PAID before the grace rules", () => {
  const succeeded = charge("SUCCEEDED");
  // Rule 1 over rule 2: a refunded link with a SUCCEEDED charge (the charge stays SUCCEEDED after a refund).
  for (const status of ["VOIDED", "REFUNDED"]) {
    const s = run(link(status), [succeeded], DURING);
    assert.equal(s.state, "refunded", status);
    assert.equal(s.primary, succeeded, `${status}: the refunded charge is still named`);
    assert.deepEqual(s.succeeded, [succeeded]);
    assert.equal(s.amountSatang, NET);
  }
  // Rule 2 over rules 6 and 7: a late success on an EXPIRED or DISABLED link, long after the grace and the 24 hours.
  for (const status of ["EXPIRED", "DISABLED"]) {
    const late = charge("SUCCEEDED", { createdAt: bangkokTime(EXPIRES - MIN) });
    const s = run(link(status), [charge("PENDING"), late, charge("FAILED")], EXPIRES + 3 * BEAM_PENDING_BLOCK_MS);
    assert.equal(code(s), "paid", status);
    assert.equal(s.primary, late);
  }
  // Rule 2 over rule 5: an ACTIVE link (Beam's lag) past expiry with a SUCCEEDED charge is paid, never disabled.
  assert.equal(code(run(link("ACTIVE"), [succeeded], LATE)), "paid");
  // Rule 3 over rules 4-8: PAID without a listed charge is paid whatever the clock says.
  assert.equal(code(run(link("PAID"), [charge("PENDING")], LATE + BEAM_PENDING_BLOCK_MS)), "paid");
  // Rule 6 (inside the grace) over rule 7: a FAILED charge does not cancel a PENDING one.
  assert.equal(code(run(link("EXPIRED"), [charge("FAILED"), charge("PENDING")], EXPIRES + MIN)), "processing/processing");
  // Rule 8 over rules 6 and 7: a charge whose status we do not know keeps the hold after the grace and the 24 hours.
  const unknownAndPending = [charge("CANCELLED"), charge("PENDING")];
  assert.equal(code(run(link("EXPIRED"), unknownAndPending, EXPIRES + MIN)), "processing/processing", "inside the grace: why it is pending");
  assert.equal(code(run(link("EXPIRED"), unknownAndPending, LATE + BEAM_PENDING_BLOCK_MS)), "processing", "after it: never released");
  assert.equal(code(run(link("DISABLED"), [charge(""), charge("FAILED")], LATE)), "processing");
});

test("an EXPIRED or DISABLED link with a PENDING charge and no readable expiresAt stays processing (the grace cannot be measured)", () => {
  for (const expiresAt of [undefined, "", "soon", "2026-10-22T10:30:00"]) {
    for (const status of ["EXPIRED", "DISABLED"]) {
      const l = link(status, { expiresAt });
      assert.equal(code(run(l, [charge("PENDING")], LATE + 30 * BEAM_PENDING_BLOCK_MS)), "processing/processing", `${status} ${expiresAt}`);
      assert.equal(code(run(l, [charge("FAILED")], LATE)), "expired", `${status} ${expiresAt}: no PENDING charge`);
      assert.equal(code(run(l, [], LATE)), "expired");
    }
  }
});

test("only PAYMENT_LINK charges of this link count", () => {
  const foreign = chargeSet("foreign");
  for (const status of ["ACTIVE", "EXPIRED", "DISABLED"]) {
    const s = run(link(status), foreign, LATE);
    assert.equal(s.primary, null, status);
    assert.deepEqual(s.succeeded, []);
    assert.deepEqual(s.pending, []);
    assert.equal(s.attempted, false);
  }
  // A foreign SUCCEEDED charge next to this link's own FAILED one: still not paid.
  const own = charge("FAILED");
  const s = run(link("EXPIRED"), [charge("SUCCEEDED", { sourceId: OTHER_LINK_ID }), own], LATE);
  assert.equal(code(s), "expired");
  assert.equal(s.attempted, true);
  // Junk entries in the list are skipped.
  const junk = [null, undefined, 42, "ch_x"] as unknown as BeamCharge[];
  assert.equal(code(run(link("EXPIRED"), junk, LATE)), "expired");
});

test("a link answer without its paymentLinkId is processing, even next to charges without a sourceId", () => {
  for (const paymentLinkId of [undefined, "", 7]) {
    const l = { ...link("EXPIRED"), paymentLinkId } as unknown as BeamPaymentLink;
    const s = run(l, [charge("SUCCEEDED", { sourceId: undefined }), charge("FAILED", { sourceId: undefined })], LATE);
    assert.equal(code(s), "processing", String(paymentLinkId));
    assert.equal(s.attempted, false);
    assert.equal(s.primary, null);
  }
});

test("oldest first: createdAt across offsets, an unreadable createdAt counts as newest, ties keep Beam's newest-first order reversed", () => {
  const a = charge("SUCCEEDED", { createdAt: "2026-10-22T10:04:00+07:00" }); // 03:04Z
  const b = charge("SUCCEEDED", { createdAt: "2026-10-22T03:02:00Z" });
  const c = charge("SUCCEEDED", { createdAt: undefined });
  const d = charge("SUCCEEDED", { createdAt: "2026-10-22T10:03:00" }); // no zone: not read
  let s = run(link("PAID"), [c, a, d, b], DURING);
  assert.deepEqual(s.succeeded, [b, a, d, c]);
  assert.equal(s.primary, b);

  const sameTime = bangkokTime(T0 + 5 * MIN);
  const newest = charge("PENDING", { createdAt: sameTime });
  const oldest = charge("PENDING", { createdAt: sameTime });
  s = run(link("ACTIVE"), [newest, oldest], DURING);
  assert.deepEqual(s.pending, [oldest, newest]);

  // The caller's list is not reordered.
  const list = [c, a, d, b];
  run(link("PAID"), list, DURING);
  assert.deepEqual(list, [c, a, d, b]);
});

test("a charge listed twice counts once; a SUCCEEDED copy wins over a stale PENDING one", () => {
  const pendingCopy = charge("PENDING");
  const succeededCopy: BeamCharge = { ...pendingCopy, status: "SUCCEEDED", transactionTime: bangkokTime(T0 + 6 * MIN) };
  for (const list of [
    [pendingCopy, succeededCopy],
    [succeededCopy, pendingCopy],
  ]) {
    const s = run(link("EXPIRED"), list, LATE);
    assert.equal(code(s), "paid");
    assert.deepEqual(s.succeeded, [succeededCopy], "one charge, not a double charge");
    assert.deepEqual(s.pending, []);
  }
  const twice = charge("SUCCEEDED");
  assert.equal(run(link("PAID"), [twice, { ...twice }], DURING).succeeded.length, 1);
  // Charges without an id cannot be told apart: each counts.
  const noId = [charge("SUCCEEDED", { chargeId: "" }), charge("SUCCEEDED", { chargeId: "" })];
  assert.equal(run(link("PAID"), noId, DURING).succeeded.length, 2);
});

test("invalid options throw", () => {
  const l = link("ACTIVE");
  assert.throws(() => beamPaymentState(l, [], { nowMs: Number.NaN, graceMs: GRACE }), RangeError);
  assert.throws(() => beamPaymentState(l, [], { nowMs: DURING, graceMs: -1 }), RangeError);
  assert.throws(() => beamPaymentState(l, [], { nowMs: DURING, graceMs: Number.POSITIVE_INFINITY }), RangeError);
  assert.throws(() => beamPaymentState(l, [], { nowMs: DURING, graceMs: GRACE, skewMs: -1 }), RangeError);
  assert.throws(() => beamPaymentState(l, [], { nowMs: DURING, graceMs: GRACE, pendingBlockMs: Number.NaN }), RangeError);
  assert.equal(beamPaymentState(l, [], { nowMs: DURING, graceMs: 0, skewMs: 0, pendingBlockMs: 0 }).state, "open");
});

/* ---------------- the real client against the fake Beam ---------------- */

const FAST = { sleep: async () => undefined, random: () => 0 };

const quoteLine: QuoteLine = {
  slug: "sunrise-suite",
  roomName: "Sunrise Suite",
  ratePlanId: "standard",
  ratePlanName: "Standard Rate",
  adults: 2,
  nights: 3,
  nightly: [],
  occupancyExtraSatang: 0,
  roomSatang: 2_400_000,
  addons: [],
  addonsSatang: 0,
};
const quote: Quote = {
  currency: "THB",
  checkIn: "2026-11-10",
  checkOut: "2026-11-13",
  nights: 3,
  lines: [quoteLine],
  roomsSubtotalSatang: 2_400_000,
  addonsSubtotalSatang: 0,
  promo: null,
  feeBaseSatang: 2_400_000,
  cardFeePct: 3,
  cardFeeSatang: 72_000,
  totalSatang: NET,
  depositPct: 100,
  dueNowSatang: NET,
  balanceSatang: 0,
};

function fakeSetup(options: FakeBeamOptions = {}) {
  let t = T0;
  const fake = createFakeBeam({ now: () => t, ...options });
  let key = 0;
  return {
    fake,
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
    async newLink(group: BeamMethodGroup = "card_ewallet"): Promise<string> {
      const body = buildPaymentLinkRequest({
        ref: REF,
        quote: group === "promptpay" ? { ...quote, cardFeePct: 0, cardFeeSatang: 0, totalSatang: 2_400_000, dueNowSatang: 2_400_000 } : quote,
        merchantName: "Magic Suites & Villas",
        redirectUrl: `https://magicsamui.com/booking/return?ref=${REF}&t=x`,
        cancelUrl: `https://magicsamui.com/booking?resume=payment&ref=${REF}&t=x`,
        nowMs: t,
        ttlMinutes: 30,
        group,
        ewallets: true,
        internalNote: "msv1|m=beam-playground|r=MSV-20261022-7F3K|s=abcdefghijklmnopqrstuvwxyz0",
        expectedFeePct: group === "promptpay" ? 0 : 3,
      });
      return (await createPaymentLink(fake.creds, body, `msv-state-test-${++key}`, fake.fetch)).id;
    },
    /** What the Beam gateway will do: GET the link, list its charges, then judge (by the fake's clock unless told otherwise). */
    async read(id: string, nowMs = t): Promise<BeamPaymentState> {
      const l = await getPaymentLink(fake.creds, id, fake.fetch, FAST);
      const charges = await listPaymentLinkCharges(fake.creds, { sourceId: id }, fake.fetch, FAST);
      return beamPaymentState(l, charges, { nowMs, graceMs: GRACE });
    },
  };
}

test("fake Beam: a PromptPay QR left pending through expiry, the grace and a late success", async () => {
  const k = fakeSetup();
  const id = await k.newLink("promptpay");
  assert.equal(code(await k.read(id)), "open");
  assert.equal((await k.read(id)).amountSatang, 2_400_000);

  k.advance(5 * MIN);
  const qr = k.fake.payPending(id);
  let s = await k.read(id);
  assert.equal(code(s), "processing/processing");
  assert.equal(s.pending[0].chargeId, qr.chargeId);
  assert.equal(s.attempted, true);

  k.advance(26 * MIN); // past expiresAt: the fake expires the link itself
  assert.equal(code(await k.read(id)), "processing/processing");

  k.advance(GRACE); // past expiresAt + grace
  assert.equal(code(await k.read(id)), "expired/unconfirmed");

  k.advance(3 * 60 * MIN);
  k.fake.payAfterClose(id); // the pending charge succeeds; the link stays EXPIRED
  s = await k.read(id);
  assert.equal(code(s), "paid");
  assert.equal(s.primary?.chargeId, qr.chargeId);
  assert.equal(s.primary?.paymentMethod?.paymentMethodType, "QR_PROMPT_PAY");
  assert.equal(s.amountSatang, 2_400_000);
  assert.equal(s.currency, "THB");
});

test("fake Beam: open, declined, disabled, PAID before its charge is listed, a double charge, a refund", async () => {
  const k = fakeSetup();

  // A declined card leaves the link open; it then expires with nothing pending.
  const declined = await k.newLink();
  k.fake.decline(declined);
  assert.equal(code(await k.read(declined)), "open");
  k.advance(31 * MIN);
  assert.equal(code(await k.read(declined)), "expired");

  // An ACTIVE link a lagging Beam has not expired yet (expiryLagMs), on the fake's own clock:
  // needsDisable -> PATCH disable (the real client) -> re-read.
  const lagging = fakeSetup({ expiryLagMs: 10 * MIN });
  const stale = await lagging.newLink();
  lagging.advance(30 * MIN + BEAM_EXPIRY_SKEW_MS - 1);
  assert.equal(code(await lagging.read(stale)), "open", "1 ms before expiresAt + skew");
  lagging.advance(1);
  assert.equal(code(await lagging.read(stale)), "open+disable");
  assert.equal(await disablePaymentLink(lagging.fake.creds, stale, "msv-bd-stale-1", lagging.fake.fetch), "disabled");
  assert.equal(code(await lagging.read(stale)), "expired");
  // A repeated disable (a fresh key) is 'not_open', and the re-read still says expired.
  assert.equal(await disablePaymentLink(lagging.fake.creds, stale, "msv-bd-stale-2", lagging.fake.fetch), "not_open");
  assert.equal(code(await lagging.read(stale)), "expired");

  // PAID while the charge list lags: paid with no primary, then the charge appears.
  const lag = await k.newLink();
  const hidden = k.fake.markPaidWithoutCharge(lag);
  let s = await k.read(lag);
  assert.equal(code(s), "paid");
  assert.equal(s.primary, null);
  assert.equal(s.amountSatang, NET);
  k.fake.revealCharges(lag);
  s = await k.read(lag);
  assert.equal(s.primary?.chargeId, hidden.chargeId);

  // A second SUCCEEDED charge on the same link.
  k.advance(MIN);
  const second = k.fake.secondCharge(lag, "ALIPAY");
  s = await k.read(lag);
  assert.deepEqual(
    s.succeeded.map((c) => c.chargeId),
    [hidden.chargeId, second.chargeId],
  );
  assert.equal(s.primary?.chargeId, hidden.chargeId);

  // A refund in Lighthouse: the link turns REFUNDED, the charge stays SUCCEEDED.
  const paid = await k.newLink();
  const card = k.fake.pay(paid);
  assert.equal(code(await k.read(paid)), "paid");
  k.fake.refund(card.chargeId);
  s = await k.read(paid);
  assert.equal(code(s), "refunded");
  assert.equal(s.primary?.chargeId, card.chargeId);

  // A wrong-amount charge.
  const wrong = await k.newLink();
  k.fake.pay(wrong, "CARD", { amount: NET - 1 });
  assert.equal(code(await k.read(wrong)), "paid!mismatch");
});

/** A wallet attempt begun first and left pending, then the card pays, then the wallet confirms late. */
async function lateWalletAfterCard(k: ReturnType<typeof fakeSetup>) {
  const id = await k.newLink();
  k.advance(MIN);
  const alipay = k.fake.payPending(id, "ALIPAY");
  assert.equal(code(await k.read(id)), "processing/processing");
  k.advance(2 * MIN);
  const card = k.fake.pay(id, "CARD");
  const paid = await k.read(id);
  assert.equal(code(paid), "paid");
  assert.equal(paid.primary?.chargeId, card.chargeId);
  assert.deepEqual(
    paid.pending.map((c) => c.chargeId),
    [alipay.chargeId],
  );
  k.advance(2 * MIN);
  k.fake.succeed(alipay.chargeId); // the link was PAID already and stays PAID
  return { id, alipay, card };
}

test("fake Beam: a late wallet confirmation after the card paid never takes the primary's place (round-1 review issue 1)", async () => {
  const k = fakeSetup();
  const { id, alipay, card } = await lateWalletAfterCard(k);
  for (const nowMs of [k.now(), LATE, LATE + 2 * BEAM_PENDING_BLOCK_MS]) {
    const s = await k.read(id, nowMs);
    assert.equal(code(s), "paid");
    assert.equal(s.primary?.chargeId, card.chargeId, "the card paid the booking: it stays primary on every read");
    assert.equal(s.primary?.paymentMethod?.paymentMethodType, "CARD");
    assert.deepEqual(
      s.succeeded.map((c) => c.chargeId),
      [card.chargeId, alipay.chargeId],
      "in the order they succeeded (the wallet charge is older by createdAt)",
    );
    assert.deepEqual(s.pending, []);
    assert.equal(s.amountSatang, NET);
  }
  assert.ok(k.fake.charge(alipay.chargeId).createdMs < k.fake.charge(card.chargeId).createdMs);
});

test("fake Beam: CARD pays, a late ALIPAY succeeds, only the ALIPAY charge is refunded -> never plain 'refunded' (round-1 review issue 0)", async () => {
  for (const refundLinkStatus of ["any_refund", "all_charges_fully_refunded"] as const) {
    const k = fakeSetup({ refundLinkStatus });
    const { id, alipay, card } = await lateWalletAfterCard(k);
    k.advance(60 * MIN);
    k.fake.refund(alipay.chargeId); // the owner refunds the duplicate in Lighthouse
    const s = await k.read(id);
    assert.equal(s.state, "paid", refundLinkStatus);
    assert.equal(s.primary?.chargeId, card.chargeId);
    assert.deepEqual(
      s.succeeded.map((c) => c.chargeId),
      [card.chargeId, alipay.chargeId],
      "a refunded charge stays SUCCEEDED",
    );
    const linkStatus = (await getPaymentLink(k.fake.creds, id, k.fake.fetch, FAST)).status;
    if (refundLinkStatus === "any_refund") {
      // Beam moves the link to REFUNDED although the card payment is kept: which charge was refunded can't be told.
      assert.equal(linkStatus, "REFUNDED");
      assert.equal(code(s), "paid!mismatch!ambiguous");
      assert.match(s.mismatch ?? "", /^Beam payment link \S+ is REFUNDED but has 2 SUCCEEDED charges \(.+\): check in Lighthouse which charges were refunded$/);
    } else {
      // The link stays PAID: an ordinary double charge, which the gateway alerts (money review 3).
      assert.equal(linkStatus, "PAID");
      assert.equal(code(s), "paid");
    }
    // Even with the card refunded too, the link alone cannot prove it: still the owner's check, never 'refunded'.
    k.fake.refund(card.chargeId);
    assert.equal(code(await k.read(id)), "paid!mismatch!ambiguous", refundLinkStatus);
  }
});
