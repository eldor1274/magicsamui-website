// The state of a Beam payment link, from the link and its charges (S2.3).
// Pure: no I/O, no clock (the caller passes nowMs). Server only, because it
// reads beam.ts's types and time parser.
//
// beamPaymentState(link, charges, options) answers in GatewayState terms plus
// what the Beam gateway needs around it (every SUCCEEDED charge, the PENDING
// ones, whether we must disable the link ourselves, why it is pending).
// Only charges with source PAYMENT_LINK and sourceId = the link's own id
// count; anything else in the list is ignored. A charge listed twice (the
// same chargeId) counts once, and a SUCCEEDED copy wins over any other copy.
//
// Rules, first match wins:
// 1. Link VOIDED or REFUNDED -> 'refunded', even with a SUCCEEDED charge
//    (money review 4: a refunded booking is never confirmed).
// 2. Any SUCCEEDED charge -> 'paid', whatever the link status (an ACTIVE lag,
//    or a late success on an EXPIRED or DISABLED link). Amount and currency
//    come from the primary (oldest) charge; mismatch when that amount differs
//    from link.order.netAmount or its currency is not THB. succeeded lists
//    every SUCCEEDED charge, so the gateway can tell a double charge (money
//    review 3).
// 3. Link PAID with no SUCCEEDED charge listed -> 'paid' with amount =
//    link.order.netAmount and primary null: "charge id pending" (gap review 2,
//    money review 7).
// 4. ACTIVE before expiresAt + skew -> 'processing' (pendingReason
//    'processing') with a PENDING charge, else 'open'.
// 5. ACTIVE at or after expiresAt + skew -> the same answer as rule 4 plus
//    needsDisable (Beam should have expired it; we disable it ourselves).
// 6. EXPIRED or DISABLED with a PENDING charge: before expiresAt + grace ->
//    'processing' (pendingReason 'processing'); at or after it -> 'expired'
//    with pendingReason 'unconfirmed' while the youngest PENDING charge is
//    younger than pendingBlockMs (money review 8: the guest is told not to
//    pay again), plain 'expired' after that.
// 7. EXPIRED or DISABLED with only FAILED charges, or none -> 'expired'.
// 8. Any other or unknown status -> 'processing': we never release a hold on
//    an answer we do not understand.
//
// Rule 8 also covers what rules 1-7 do not name, so that no unreadable answer
// can ever read as 'open' or 'expired':
// - a link answer without its paymentLinkId -> 'processing' (its charges
//   cannot be told apart from another link's);
// - a charge whose status is not PENDING, SUCCEEDED or FAILED keeps an ACTIVE
//   link 'processing', and an EXPIRED or DISABLED one 'processing' once its
//   grace is over (it stops rules 6 and 7 from releasing);
// - an EXPIRED or DISABLED link with a PENDING charge and no readable
//   expiresAt stays 'processing' (the grace cannot be measured).
//
// 'failed' is never answered: a declined attempt leaves the link ACTIVE so the
// guest can try again, and a link that closes after it is 'expired'.
//
// Times: createdAt and expiresAt are read with parseBeamTime (Z or an offset
// only). "Oldest first" orders by createdAt; a charge without a readable
// createdAt counts as the newest, and equal times keep Beam's newest-first
// listing order reversed. A PENDING charge without a readable createdAt is
// aged from the link's expiresAt (it was begun before the link closed), which
// can only make the 24-hour block last longer, never shorter.
//
// UNVERIFIED (Beam question 2): whether a PENDING charge can still succeed
// after its link is DISABLED or EXPIRED. The rules assume it can.

import { parseBeamTime } from "../beam.ts";
import type { BeamCharge, BeamPaymentLink } from "../beam.ts";
import type { GatewayState } from "./gateway.ts";

/** How far past expiresAt an ACTIVE link may run before we disable it ourselves (clock skew and Beam's own lag). */
export const BEAM_EXPIRY_SKEW_MS = 120_000;

/** How long after its creation a still-PENDING charge keeps answering 'unconfirmed' (do not pay again). */
export const BEAM_PENDING_BLOCK_MS = 24 * 60 * 60 * 1000;

/** Why a payment is pending: a charge awaits confirmation, or its grace ran out unconfirmed (money review 8). */
export type BeamPendingReason = "processing" | "unconfirmed";

export interface BeamStateOptions {
  /** The time to judge by, epoch ms. */
  nowMs: number;
  /** How long after expiresAt a PENDING charge keeps an EXPIRED or DISABLED link 'processing' (BEAM_PENDING_GRACE_MINUTES, S3.1). */
  graceMs: number;
  /** Default BEAM_EXPIRY_SKEW_MS (2 minutes). */
  skewMs?: number;
  /** Default BEAM_PENDING_BLOCK_MS (24 hours). */
  pendingBlockMs?: number;
}

export interface BeamPaymentState {
  state: GatewayState;
  /** Every SUCCEEDED charge of the link, oldest first (more than one: the guest paid twice). */
  succeeded: BeamCharge[];
  /** The oldest SUCCEEDED charge; null when there is none (also a PAID link whose charge is not listed yet). */
  primary: BeamCharge | null;
  /** Every PENDING charge of the link, oldest first. */
  pending: BeamCharge[];
  /** An ACTIVE link at or past expiresAt + skew, with no SUCCEEDED charge: disable it, then read it again. */
  needsDisable: boolean;
  /** Present when the answer is pending because of a PENDING charge. */
  pendingReason?: BeamPendingReason;
  /**
   * The primary charge's amount and currency when there is one, else the link order's. null when Beam gave
   * no finite number or no currency string.
   */
  amountSatang: number | null;
  currency: string | null;
  /** The primary charge disagrees with the link's order (amount, or a currency other than THB). No personal data. */
  mismatch?: string;
  /** A payment was started on Beam's page: the link has at least one charge. */
  attempted: boolean;
}

type ChargeKind = "succeeded" | "pending" | "failed" | "other";

function kindOf(status: unknown): ChargeKind {
  if (status === "SUCCEEDED") return "succeeded";
  if (status === "PENDING") return "pending";
  if (status === "FAILED") return "failed";
  return "other";
}

function checkTime(name: string, v: unknown, min: number | null): void {
  if (typeof v !== "number" || !Number.isFinite(v) || (min !== null && v < min)) {
    throw new RangeError(`${name} must be a finite number${min === null ? "" : ` >= ${min}`}`);
  }
}

function finiteOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function stringOrNull(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/** The link's own charges, each chargeId once (a SUCCEEDED copy wins), oldest first. */
function linkCharges(linkId: string, charges: readonly BeamCharge[]): BeamCharge[] {
  const entries: { charge: BeamCharge; pos: number; createdMs: number }[] = [];
  const byId = new Map<string, number>();
  charges.forEach((c, pos) => {
    if (!c || typeof c !== "object" || c.source !== "PAYMENT_LINK" || c.sourceId !== linkId) return;
    const id = typeof c.chargeId === "string" && c.chargeId !== "" ? c.chargeId : null;
    const entry = { charge: c, pos, createdMs: parseBeamTime(c.createdAt) ?? Number.POSITIVE_INFINITY };
    if (id !== null) {
      const seen = byId.get(id);
      if (seen !== undefined) {
        if (kindOf(c.status) === "succeeded" && kindOf(entries[seen].charge.status) !== "succeeded") {
          entries[seen] = { ...entry, pos: entries[seen].pos };
        }
        return;
      }
      byId.set(id, entries.length);
    }
    entries.push(entry);
  });
  // Beam lists newest first: on equal (or unreadable) times, a later position is the older charge.
  entries.sort((a, b) => (a.createdMs !== b.createdMs ? (a.createdMs < b.createdMs ? -1 : 1) : b.pos - a.pos));
  return entries.map((e) => e.charge);
}

function amountMismatch(linkId: string, netAmount: number | null, charge: BeamCharge): string | undefined {
  const amount = finiteOrNull(charge.amount);
  const currency = stringOrNull(charge.currency);
  const id = typeof charge.chargeId === "string" && charge.chargeId !== "" ? charge.chargeId : "(no id)";
  const problems: string[] = [];
  if (amount === null || netAmount === null || amount !== netAmount) {
    problems.push(`amount ${amount ?? "unknown"} does not match the link's netAmount ${netAmount ?? "unknown"}`);
  }
  if (currency === null || currency.toUpperCase() !== "THB") problems.push(`currency ${currency || "unknown"} is not THB`);
  return problems.length === 0 ? undefined : `Beam charge ${id} on payment link ${linkId}: ${problems.join("; ")}`;
}

/** The state of a Beam payment link from its GET answer and its charges (see the rules above). */
export function beamPaymentState(link: BeamPaymentLink, charges: readonly BeamCharge[], options: BeamStateOptions): BeamPaymentState {
  const { nowMs, graceMs, skewMs = BEAM_EXPIRY_SKEW_MS, pendingBlockMs = BEAM_PENDING_BLOCK_MS } = options;
  checkTime("nowMs", nowMs, null);
  checkTime("graceMs", graceMs, 0);
  checkTime("skewMs", skewMs, 0);
  checkTime("pendingBlockMs", pendingBlockMs, 0);

  const order = link && typeof link.order === "object" && link.order !== null ? link.order : null;
  const orderAmount = finiteOrNull(order?.netAmount);
  const orderCurrency = stringOrNull(order?.currency);
  const linkId = link && typeof link.paymentLinkId === "string" && link.paymentLinkId !== "" ? link.paymentLinkId : null;

  const base = (fields: Partial<BeamPaymentState> & { state: GatewayState }): BeamPaymentState => ({
    succeeded: [],
    primary: null,
    pending: [],
    needsDisable: false,
    amountSatang: orderAmount,
    currency: orderCurrency,
    attempted: false,
    ...fields,
  });

  // Rule 8: without the link's id its charges cannot be told apart from another link's.
  if (linkId === null) return base({ state: "processing" });

  const own = linkCharges(linkId, charges);
  const succeeded = own.filter((c) => kindOf(c.status) === "succeeded");
  const pending = own.filter((c) => kindOf(c.status) === "pending");
  const other = own.filter((c) => kindOf(c.status) === "other");
  const primary = succeeded[0] ?? null;
  const common = { succeeded, primary, pending, attempted: own.length > 0 };
  const status: unknown = link.status;

  /** The answer quotes the primary charge's own amount and currency, and says when they disagree with the order. */
  const fromPrimary = (state: GatewayState, p: BeamCharge): BeamPaymentState => {
    const mismatch = amountMismatch(linkId, orderAmount, p);
    return base({ ...common, state, amountSatang: finiteOrNull(p.amount), currency: stringOrNull(p.currency), ...(mismatch ? { mismatch } : {}) });
  };

  // Rule 1: a refund (or void) beats any SUCCEEDED charge.
  if (status === "VOIDED" || status === "REFUNDED") return primary ? fromPrimary("refunded", primary) : base({ ...common, state: "refunded" });

  // Rule 2: money was taken, whatever the link says.
  if (primary) return fromPrimary("paid", primary);

  // Rule 3: PAID before its charge is listed: paid at the order's amount, charge id pending.
  if (status === "PAID") return base({ ...common, state: "paid" });

  const expiresMs = parseBeamTime(link.expiresAt);

  // Rules 4 and 5.
  if (status === "ACTIVE") {
    const needsDisable = expiresMs !== null && nowMs >= expiresMs + skewMs;
    if (pending.length > 0) return base({ ...common, state: "processing", pendingReason: "processing", needsDisable });
    if (other.length > 0) return base({ ...common, state: "processing", needsDisable });
    return base({ ...common, state: "open", needsDisable });
  }

  if (status === "EXPIRED" || status === "DISABLED") {
    // Rule 6, inside the grace (or with no expiresAt to measure it from).
    if (pending.length > 0 && (expiresMs === null || nowMs < expiresMs + graceMs)) {
      return base({ ...common, state: "processing", pendingReason: "processing" });
    }
    // Rule 8: a charge in a state we do not know keeps the hold.
    if (other.length > 0) return base({ ...common, state: "processing" });
    // Rule 6, after the grace.
    if (pending.length > 0 && expiresMs !== null) {
      const youngestMs = Math.max(...pending.map((c) => parseBeamTime(c.createdAt) ?? expiresMs));
      if (nowMs - youngestMs < pendingBlockMs) return base({ ...common, state: "expired", pendingReason: "unconfirmed" });
      return base({ ...common, state: "expired" });
    }
    // Rule 7.
    return base({ ...common, state: "expired" });
  }

  // Rule 8.
  return base({ ...common, state: "processing" });
}
