// Beam design S5.3: the return page for every Beam outcome, the Cloudbeds email as the guest's confirmation. The
// views' words per mode x sendsConfirmationEmail x view - the paid view (hold-first: the reservation number, and without
// the Cloudbeds email the save/print callout and the agreed terms), pending (being confirmed / unconfirmed, never "Try
// again"; after the poll budget), confirming, attention, mismatch, the unpaid views and the error views - rendered with
// react-dom/server from components/booking/return/ReturnStatus.tsx (transpiled with the repo's TypeScript through the
// same "@/" resolve hook the other UI tests use), and the pure words in returnView.ts. Every Stripe and demo string is
// pinned as it was; no Beam string mentions a receipt or Stripe. Then both providers' bookings in every outcome
// (beamTestkit.ts makeParityKit, makeBeamKit) are rendered from their real status answers, and the return page's server
// check (returnPageStatus.ts returnPageCheck) is run on the real runtime deps: a Beam answer carries the flags of the
// Beam config that answered it, also after a BOOKING_PAYMENT_PROVIDER typo, where the public config is the locked one.

import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import nodeModule from "node:module";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { buildOffers } from "./availability.ts";
import { BEAM_API_KEY, BEAM_HMAC_KEY_B64, BEAM_MERCHANT_ID, beamRunCheckout, makeBeamKit, makeParityKit } from "./beamTestkit.ts";
import type { BeamKit, ParityKit } from "./beamTestkit.ts";
import { POLICY_VERSION } from "./catalogue.ts";
import { BEAM_PLAYGROUND_BASE, getPublicBookingConfig } from "./config.ts";
import type { BookingConfig, Env } from "./config.ts";
import { addDays } from "./dates.ts";
import { demoInventory } from "./demoProvider.ts";
import { createMemoryKv } from "./kv.ts";
import { createFakeBeam } from "./mock/fakeBeam.ts";
import { createFakeCloudbeds } from "./mock/fakeCloudbeds.ts";
import {
  BEAM_CONFIRMATION_EMAIL_TEXT,
  BEAM_PAID_LEAD,
  BEAM_UNPAID_COPY,
  STRIPE_UNPAID_COPY,
  UNPAID_COPY,
  beamPaidCopy,
  beamPendingCopy,
  beamPolledReason,
  canRetryPayment,
  nextPolledReason,
  pollPlan,
  returnViewKind,
  unpaidCopy,
} from "./returnView.ts";
import type { PaidCopyFlags, PolledReason, UnpaidStatus } from "./returnView.ts";
import { runStatus } from "./status.ts";
import type { ProviderDepsFn } from "./stripeDeps.ts";
import { GUEST, NOW, TOKEN_SECRET } from "./testkit.ts";
import { createBookingToken, verifyBookingToken } from "./token.ts";
import type { ApiError, BookingSummary, CartItemInput, CheckoutSuccess, FulfilmentView, PaymentMode, PaymentStatus, Quote, StatusResponse } from "./types.ts";

type ReturnStatusProps = import("../../components/booking/return/ReturnStatus.tsx").ReturnStatusProps;

const MIN = 60_000;
/** BEAM_PENDING_GRACE_MINUTES' default. */
const GRACE_MS = 20 * MIN;
const STRIPE_MODES: PaymentMode[] = ["stripe-live", "stripe-test", "stripe-mock"];
const BEAM_MODES: PaymentMode[] = ["beam-playground", "beam-live"];
const ALL_MODES: PaymentMode[] = [...STRIPE_MODES, "demo", ...BEAM_MODES];
const WRITES = ["none", "mock", "live"] as const;
const REF = "MSV-20271110-QX7K";
const RESERVATION_ID = "7000000123456";
const GARDEN: CartItemInput[] = [{ slug: "garden-suite", ratePlanId: "standard", adults: 2, addonIds: [] }];
const SUNRISE: CartItemInput[] = [{ slug: "sunrise-suite", ratePlanId: "standard", adults: 2, addonIds: [] }];

/* ------------------------------------------ loading the return page ------------------------------------------ */

let hooked = false;
/** "@/" -> src/, extensionless relative imports inside src/, next/server and next/link, and .tsx transpiled with the repo's TypeScript. */
function hookReturnPage(): void {
  if (hooked) return;
  hooked = true;
  type Resolve = (s: string, c: { parentURL?: string }, n: (s: string, c: { parentURL?: string }) => unknown) => unknown;
  type Load = (u: string, c: unknown, n: (u: string, c: unknown) => unknown) => unknown;
  const { registerHooks } = nodeModule as unknown as { registerHooks?: (hooks: { resolve: Resolve; load: Load }) => void };
  if (!registerHooks) throw new Error("module.registerHooks is required (Node 22.15+ / 23.5+)");
  const src = fileURLToPath(new URL("../../", import.meta.url));
  const probe = (base: URL) => {
    for (const ext of ["", ".ts", ".tsx", "/index.ts"]) {
      const url = new URL(`${base.href}${ext}`);
      const path = fileURLToPath(url);
      if (existsSync(path) && statSync(path).isFile()) return { url: url.href, shortCircuit: true };
    }
    return null;
  };
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "next/server") return nextResolve("next/server.js", context);
      // next/link is CommonJS whose module.exports is the component itself (as Next's bundler hands it on).
      if (specifier === "next/link") return nextResolve("next/link.js", context);
      if (specifier.startsWith("@/")) return probe(new URL(`../../${specifier.slice(2)}`, import.meta.url)) ?? nextResolve(specifier, context);
      const parent = context.parentURL;
      if (specifier.startsWith(".") && parent?.startsWith("file:") && fileURLToPath(parent).startsWith(src)) {
        return probe(new URL(specifier, parent)) ?? nextResolve(specifier, context);
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (!url.startsWith("file:") || !url.endsWith(".tsx") || !fileURLToPath(url).startsWith(src)) return nextLoad(url, context);
      const out = ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
        fileName: fileURLToPath(url),
        compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false },
      });
      return { format: "module", source: out.outputText, shortCircuit: true };
    },
  });
}

/**
 * Runs `fn` with no global window, as on the server: another test file of this process (`node --test src/lib/booking`
 * may import them all into one) may have left a stand-in window behind.
 */
async function withoutWindow<T>(fn: () => Promise<T> | T): Promise<T> {
  const g = globalThis as { window?: unknown };
  const had = Object.prototype.hasOwnProperty.call(g, "window");
  const before = g.window;
  delete g.window;
  try {
    return await fn();
  } finally {
    if (had) g.window = before;
  }
}

type ReturnStatusComponent = (props: ReturnStatusProps) => unknown;
let component: ReturnStatusComponent | null = null;

async function returnStatus(): Promise<ReturnStatusComponent> {
  hookReturnPage();
  component ??= await withoutWindow(async () => (await import("../../components/booking/return/ReturnStatus.tsx")).default as ReturnStatusComponent);
  return component;
}

/** The return page's server render (renderToStaticMarkup: before hydration, as the first HTML a guest gets). */
async function render(props: ReturnStatusProps): Promise<string> {
  const ReturnStatus = await returnStatus();
  return withoutWindow(() => renderToStaticMarkup(createElement(ReturnStatus as never, props as never)));
}

const decode = (s: string) =>
  s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** The visible text, one chunk per text node run (React's "<!-- -->" separators dropped). */
function chunks(html: string): string[] {
  return decode(html.replace(/<!-- -->/g, ""))
    .split(/<[^>]+>/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

const textOf = (html: string) => chunks(html).join(" ");

/** The page's persistent live region (role="status"). */
function liveRegion(html: string): string {
  const m = /<p role="status" class="bk-sr-only">([\s\S]*?)<\/p>/.exec(html);
  assert.ok(m, "the live region");
  return decode(m[1].replace(/<!-- -->/g, ""));
}

/* ----------------------------------------------- fixtures ----------------------------------------------- */

function bookingOf(mode: PaymentMode, extra: Partial<BookingSummary> = {}): BookingSummary {
  return {
    ref: REF,
    paymentMode: mode,
    checkIn: "2027-11-10",
    checkOut: "2027-11-13",
    nights: 3,
    items: [{ slug: "honeymoon-suite", ratePlanId: "standard", adults: 2, addonIds: [] }],
    itemRoomSatang: [4_050_000],
    promoCode: null,
    totalSatang: 4_171_500,
    cardFeeSatang: 121_500,
    dueNowSatang: 4_171_500,
    createdAt: "2026-10-23T03:00:00.000Z",
    linkExpiresAt: "2026-10-23T03:30:00.000Z",
    ...(mode === "beam-playground" || mode === "beam-live" ? { payMethod: "card_ewallet" as const } : {}),
    ...extra,
  };
}

function answerOf(
  mode: PaymentMode,
  status: PaymentStatus,
  fulfilment: FulfilmentView,
  extra: Partial<StatusResponse> = {},
  booking: BookingSummary = bookingOf(mode),
): StatusResponse {
  const provider = mode === "demo" ? "demo" : mode.startsWith("beam") ? "beam" : "stripe";
  return {
    ok: true,
    ref: booking.ref,
    paymentMode: mode,
    provider,
    status,
    failureCode: null,
    booking,
    fulfilment,
    purchase: null,
    checkedAt: "2026-10-23T03:05:00.000Z",
    ...extra,
  };
}

const CONFIRMED: FulfilmentView = { state: "confirmed", reservationId: RESERVATION_ID };
const confirmedFor = (mode: PaymentMode): FulfilmentView => (mode === "demo" ? { state: "not_applicable", reservationId: null } : CONFIRMED);

function propsFor(initial: StatusResponse | ApiError | null, mode: PaymentMode, flags: Partial<PaidCopyFlags> & { bookingPath?: string; showUnverifiedPreviewNote?: boolean } = {}): ReturnStatusProps {
  return {
    bookingRef: REF,
    token: "t.signed",
    proof: mode === "demo" ? "p.signed" : null,
    initial,
    paymentMode: initial?.ok ? initial.paymentMode : mode,
    theme: "magic",
    sessionId: null,
    bookingPath: flags.bookingPath ?? "/booking-preview",
    cloudbedsWrites: flags.cloudbedsWrites ?? "none",
    sendsConfirmationEmail: flags.sendsConfirmationEmail ?? false,
    showUnverifiedPreviewNote: flags.showUnverifiedPreviewNote ?? true,
  };
}

const isBeam = (mode: PaymentMode) => mode === "beam-playground" || mode === "beam-live";
const NO_RECEIPT_OR_STRIPE = /receipt|stripe/i;
const SAVE_CALLOUT = "Save or print this page - it is your booking confirmation. It can't be reopened once you close this tab.";
const TERMS_HEADING = "Booking terms";
const RESERVATION_LINE = `Reservation number: ${RESERVATION_ID}`;

/** The preview note under a view, per mode and Cloudbeds writes (null: none, live modes). */
function previewNote(mode: PaymentMode, writes: (typeof WRITES)[number]): string | null {
  switch (mode) {
    case "stripe-live":
    case "beam-live":
      return null;
    case "stripe-mock":
      return "MOCK mode - nothing was charged. The Stripe checkout was fake and the Cloudbeds reservation was simulated.";
    case "stripe-test":
      return `Stripe test mode - no real money moved. ${writes === "live" ? "A REAL Cloudbeds reservation was created for this test - check it, then cancel it in Cloudbeds." : "The Cloudbeds reservation was simulated."}`;
    case "beam-playground":
      return `Beam test mode - no real money moved. ${writes === "live" ? "A REAL Cloudbeds reservation was created for this test - check it, then cancel it in Cloudbeds." : "The Cloudbeds reservation was simulated."}`;
    case "demo":
      return "Demo mode - no real payment was taken. In live mode this is where the reservation would be created in Cloudbeds and confirmation emails sent.";
  }
}

/* --------------------------------------------- the paid view --------------------------------------------- */

interface PaidExpect {
  eyebrow: string;
  lead: string;
  /** The first "What happens next" item: its title and text, as one line. */
  email: string;
  pageIsConfirmation: boolean;
  reservationNumber: boolean;
}

/** The paid view's words, per mode x sendsConfirmationEmail x Cloudbeds writes: Stripe and the demo exactly as before S5.3. */
function paidExpect(mode: PaymentMode, email: boolean, writes: (typeof WRITES)[number]): PaidExpect {
  const testLead = `Your test payment went through and the reservation is confirmed${writes === "live" ? " in Cloudbeds" : " (simulated)"}.`;
  switch (mode) {
    case "stripe-live":
      return {
        eyebrow: "Booking confirmed",
        lead: "Your stay is booked and paid. Stripe is emailing your payment receipt to the email address you entered.",
        email: email
          ? "Confirmation email. Your booking confirmation and Stripe's payment receipt are sent to the email address you entered. Check your spam folder if they haven't arrived in a few minutes."
          : "Payment receipt. Stripe sends your payment receipt to the email address you entered; keep it with your booking reference and this page. Check your spam folder if the receipt hasn't arrived in a few minutes.",
        pageIsConfirmation: !email,
        reservationNumber: true,
      };
    case "stripe-test":
    case "stripe-mock":
      return {
        eyebrow: "Booking confirmed",
        lead: mode === "stripe-mock" ? "The MOCK payment went through and the simulated reservation is confirmed." : testLead,
        email: `${email ? "Confirmation email." : "Payment receipt."} In live mode the guest receives Stripe's payment receipt by email and the reservation is confirmed in Cloudbeds.`,
        pageIsConfirmation: !email,
        reservationNumber: true,
      };
    case "demo":
      return {
        eyebrow: "Payment successful",
        lead: "Your test payment went through - in live mode your stay would now be reserved.",
        email: "Confirmation email. In live mode the guest receives the Cloudbeds confirmation and Beam's receipt by email.",
        pageIsConfirmation: false,
        reservationNumber: false,
      };
    case "beam-live":
      return email
        ? { eyebrow: "Booking confirmed", lead: BEAM_PAID_LEAD, email: `Confirmation email. ${BEAM_CONFIRMATION_EMAIL_TEXT}`, pageIsConfirmation: false, reservationNumber: true }
        : {
            eyebrow: "Booking confirmed",
            lead: "Your stay is booked and paid.",
            email: "Booking confirmation. This page is your record of this booking and payment - save or print it and keep your booking reference.",
            pageIsConfirmation: true,
            reservationNumber: true,
          };
    case "beam-playground":
      return {
        eyebrow: "Booking confirmed",
        lead: testLead,
        email: "Confirmation email. In live mode the guest receives the Cloudbeds booking confirmation by email.",
        pageIsConfirmation: !email,
        reservationNumber: true,
      };
  }
}

test("design S5.3, the paid view per mode x sendsConfirmationEmail x Cloudbeds writes: Stripe and the demo word it exactly as before; Beam is hold-first (the reservation number; without the Cloudbeds email the save/print callout and the agreed terms) and its Cloudbeds email is the confirmation, with no receipt and no Stripe", async () => {
  for (const mode of ALL_MODES) {
    for (const email of [false, true]) {
      for (const writes of WRITES) {
        const label = `${mode} email=${email} writes=${writes}`;
        const html = await render(propsFor(answerOf(mode, "paid", confirmedFor(mode)), mode, { sendsConfirmationEmail: email, cloudbedsWrites: writes }));
        const text = textOf(html);
        const want = paidExpect(mode, email, writes);
        const c = chunks(html);
        assert.equal(c[0], `Payment confirmed. Booking ${REF}.`, `${label}: the live region`);
        assert.equal(c[1], want.eyebrow, `${label}: eyebrow`);
        assert.equal(c[2], "Thank you!", label);
        assert.equal(c[3], want.lead, `${label}: lead`);
        assert.ok(text.includes(want.email), `${label}: the email item\n${text}`);
        assert.equal(text.includes(SAVE_CALLOUT), want.pageIsConfirmation, `${label}: the save/print callout`);
        assert.equal(c.includes(TERMS_HEADING), want.pageIsConfirmation, `${label}: the agreed terms`);
        assert.equal(text.includes(RESERVATION_LINE), want.reservationNumber, `${label}: the Cloudbeds reservation number`);
        const note = previewNote(mode, writes);
        if (note) assert.ok(text.includes(note), `${label}: the preview note\n${text}`);
        for (const other of ALL_MODES.flatMap((m) => WRITES.map((w) => previewNote(m, w)))) {
          if (other && other !== note) assert.ok(!text.includes(other), `${label}: no other preview note (${other})`);
        }
        // Shared by every provider, unchanged: the stay, the fee line, the transfer, arrival, questions and the actions.
        for (const line of ["Your stay", "Payment processing fee (included)", "What happens next", "Arrival.", "Questions or special requests?", "WhatsApp us", "Print or save this confirmation", "Add to calendar", "Back to the website"]) {
          assert.ok(text.includes(line), `${label}: ${line}`);
        }
        assert.ok(!text.includes("Try again"), `${label}: never "Try again" on a paid booking`);
        if (isBeam(mode)) assert.doesNotMatch(text, NO_RECEIPT_OR_STRIPE, `${label}: no receipt, no Stripe`);
      }
    }
  }
});

test("design S5.3, beamPaidCopy: null for Stripe and the demo; Beam's words for beam-live with and without the Cloudbeds email and for beam-playground (writes live, mock or none) - never a receipt or Stripe", () => {
  for (const mode of [...STRIPE_MODES, "demo" as const]) {
    for (const email of [false, true]) assert.equal(beamPaidCopy(mode, { sendsConfirmationEmail: email, cloudbedsWrites: "live" }), null, mode);
  }
  assert.deepEqual(beamPaidCopy("beam-live", { sendsConfirmationEmail: true, cloudbedsWrites: "live" }), {
    pageIsConfirmation: false,
    eyebrow: "Booking confirmed",
    lead: "Your stay is booked and paid. Your booking confirmation is on its way to the email address you entered.",
    emailTitle: "Confirmation email.",
    emailText:
      "We email your booking confirmation to the address you entered within a few minutes - check your spam folder if it hasn't arrived. Keep it with your booking reference: it is your record of this booking and payment.",
  });
  assert.deepEqual(beamPaidCopy("beam-live", { sendsConfirmationEmail: false, cloudbedsWrites: "live" }), {
    pageIsConfirmation: true,
    eyebrow: "Booking confirmed",
    lead: "Your stay is booked and paid.",
    emailTitle: "Booking confirmation.",
    emailText: "This page is your record of this booking and payment - save or print it and keep your booking reference.",
  });
  for (const email of [false, true]) {
    for (const writes of WRITES) {
      assert.deepEqual(beamPaidCopy("beam-playground", { sendsConfirmationEmail: email, cloudbedsWrites: writes }), {
        pageIsConfirmation: !email,
        eyebrow: "Booking confirmed",
        lead: `Your test payment went through and the reservation is confirmed${writes === "live" ? " in Cloudbeds" : " (simulated)"}.`,
        emailTitle: "Confirmation email.",
        emailText: "In live mode the guest receives the Cloudbeds booking confirmation by email.",
      });
      for (const mode of BEAM_MODES) {
        assert.doesNotMatch(Object.values(beamPaidCopy(mode, { sendsConfirmationEmail: email, cloudbedsWrites: writes }) ?? {}).join(" "), NO_RECEIPT_OR_STRIPE);
      }
    }
  }
});

/* -------------------------------------------- the pending view -------------------------------------------- */

const BEAM_PROCESSING = "Your payment is being confirmed by your bank or wallet. Your room stays reserved while we wait. Please don't pay again - this page updates by itself.";
const beamUnconfirmed = (ref: string) =>
  `If your banking or wallet app shows this payment as completed, please do NOT pay again - message us on WhatsApp with booking reference ${ref} and we'll confirm your booking. If it didn't go through, nothing has been charged.`;

test("design S5.3, the pending view per mode x pendingReason: Stripe and the demo as before; Beam 'being confirmed' (also an open link) and 'unconfirmed' (the hold released: don't pay again, WhatsApp) - never 'Try again', no receipt, no Stripe", async () => {
  const STRIPE_BODY =
    "We're waiting for Stripe to confirm your payment. Once you've paid this usually takes a few seconds (a PromptPay payment can take a little longer) - please keep this page open. Your room stays reserved meanwhile.";
  for (const mode of ALL_MODES) {
    for (const reason of [undefined, "processing", "unconfirmed"] as const) {
      // Stripe and the demo never carry a reason; render them with and without one all the same (the words ignore it).
      for (const email of [false, true]) {
        const label = `${mode} reason=${reason ?? "none"} email=${email}`;
        const fulfilment: FulfilmentView = reason === "unconfirmed" ? { state: "released", reservationId: null } : { state: "awaiting_payment", reservationId: null };
        const html = await render(propsFor(answerOf(mode, "pending", fulfilment, reason ? { pendingReason: reason } : {}), mode, { sendsConfirmationEmail: email, cloudbedsWrites: "mock" }));
        const c = chunks(html);
        const text = c.join(" ");
        const [live, title, body] = STRIPE_MODES.includes(mode)
          ? ["Waiting for your payment.", "Waiting for your payment...", STRIPE_BODY]
          : mode === "demo"
            ? ["Confirming your payment.", "Confirming your payment...", "Beam is confirming your payment with your bank. This usually takes a few seconds - please keep this page open."]
            : reason === "unconfirmed"
              ? ["Waiting for your bank or wallet to confirm. Please don't pay again.", "Waiting for your bank or wallet to confirm", beamUnconfirmed(REF)]
              : ["Confirming your payment. Please don't pay again.", "Confirming your payment...", BEAM_PROCESSING];
        assert.equal(liveRegion(html), live, `${label}: the live region`);
        assert.deepEqual(c.slice(1, 4), ["Payment pending", title, body], label);
        assert.ok(text.includes("Checking automatically") && text.includes("WhatsApp us"), label);
        assert.ok(!text.includes("Try again") && !text.includes("Back to your booking"), `${label}: no new payment while checking`);
        assert.ok(!html.includes("resume=payment"), label);
        const note = previewNote(mode, "mock");
        if (note) assert.ok(text.includes(note), `${label}: ${note}`);
        if (isBeam(mode)) assert.doesNotMatch(text, NO_RECEIPT_OR_STRIPE, label);
      }
    }
  }
});

test("design S5.3, beamPendingCopy: null for Stripe and the demo; Beam's words per reason before and after the 15-minute poll budget (taking longer than usual, don't pay again, WhatsApp with the reference); never 'Try again', a receipt or Stripe", () => {
  for (const mode of [...STRIPE_MODES, "demo" as const]) {
    for (const exhausted of [false, true]) {
      for (const pendingReason of [undefined, "processing", "unconfirmed"] as const) assert.equal(beamPendingCopy({ paymentMode: mode, ref: REF, pendingReason }, exhausted), null, mode);
    }
  }
  const stopped = " Automatic checking has stopped - use Check again, or message us on WhatsApp.";
  for (const mode of BEAM_MODES) {
    for (const reason of [undefined, "processing"] as const) {
      assert.deepEqual(beamPendingCopy({ paymentMode: mode, ref: REF, pendingReason: reason }, false), {
        title: "Confirming your payment...",
        body: BEAM_PROCESSING,
        announcement: "Confirming your payment. Please don't pay again.",
      });
      assert.deepEqual(beamPendingCopy({ paymentMode: mode, ref: REF, pendingReason: reason }, true), {
        title: "This is taking longer than usual",
        body: `Please don't pay again. If your banking or wallet app shows the payment as completed, message us on WhatsApp with booking reference ${REF}.`,
        announcement: `This is taking longer than usual. Please don't pay again.${stopped}`,
      });
    }
    for (const exhausted of [false, true]) {
      assert.deepEqual(beamPendingCopy({ paymentMode: mode, ref: REF, pendingReason: "unconfirmed" }, exhausted), {
        title: "Waiting for your bank or wallet to confirm",
        body: beamUnconfirmed(REF),
        announcement: `Waiting for your bank or wallet to confirm. Please don't pay again.${exhausted ? stopped : ""}`,
      });
      for (const pendingReason of [undefined, "processing", "unconfirmed"] as const) {
        const copy = beamPendingCopy({ paymentMode: mode, ref: REF, pendingReason }, exhausted);
        assert.ok(copy);
        const all = Object.values(copy).join(" ");
        assert.doesNotMatch(all, NO_RECEIPT_OR_STRIPE);
        assert.doesNotMatch(all, /try again/i);
        assert.match(all, /don't pay again|do NOT pay again/);
      }
    }
  }
});

test("design S5.3, beamPolledReason: the poll carries a Beam pending answer's reason to the view without a new round of checks; nothing for Stripe, the demo or any other answer", () => {
  for (const mode of ALL_MODES) {
    for (const status of ["pending", "paid", "expired", "cancelled", "failed", "refunded"] as const) {
      for (const pendingReason of [undefined, "processing", "unconfirmed"] as const) {
        const got = beamPolledReason({ status, paymentMode: mode, pendingReason });
        assert.deepEqual(got, isBeam(mode) && status === "pending" ? { reason: pendingReason } : null, `${mode} ${status} ${pendingReason}`);
      }
    }
  }
});

test("design S5.3 (round 8), nextPolledReason: the words follow the reason while the page polls - a new reason under the same plan replaces it, the same plan and reason keep the kept value itself, a new plan (a new round of checks) replaces it", () => {
  const plan = pollPlan({ paymentMode: "beam-playground" });
  const other = pollPlan({ paymentMode: "beam-playground" });
  assert.notEqual(plan, other, "each round of checks has its own plan object");
  const processing: PolledReason = { plan, reason: "processing" };
  const cases: [string, PolledReason | null, PolledReason["plan"], PolledReason["reason"], PolledReason | "prev"][] = [
    ["nothing kept yet", null, plan, "processing", { plan, reason: "processing" }],
    ["nothing kept yet, no reason", null, plan, undefined, { plan, reason: undefined }],
    ["same plan, new reason (processing -> unconfirmed)", processing, plan, "unconfirmed", { plan, reason: "unconfirmed" }],
    ["same plan, the reason gone", processing, plan, undefined, { plan, reason: undefined }],
    ["same plan, same reason", processing, plan, "processing", "prev"],
    ["new plan, same reason", processing, other, "processing", { plan: other, reason: "processing" }],
    ["new plan, new reason", processing, other, "unconfirmed", { plan: other, reason: "unconfirmed" }],
  ];
  for (const [label, prev, p, reason, want] of cases) {
    const got = nextPolledReason(prev, p, { reason });
    if (want === "prev") {
      assert.equal(got, prev, `${label}: the kept value itself (no re-render)`);
      continue;
    }
    assert.deepEqual(got, want, label);
    assert.equal(got.plan, want.plan, `${label}: the plan it was read under`);
    assert.notEqual(got, prev, `${label}: a new value`);
  }
});

/* ------------------------------------ confirming, attention, mismatch ------------------------------------ */

test("design S5.3, confirming, needs_attention and mismatch as today on every provider (a mismatch is first checked against the link, as any failed answer): WhatsApp, never 'Try again'; the attention view shows the Cloudbeds reservation number; no Beam receipt or Stripe", async () => {
  const views: [string, (mode: PaymentMode) => StatusResponse, string, string[], string][] = [
    [
      "confirming",
      (mode) => answerOf(mode, "paid", { state: "confirming", reservationId: null }),
      "Payment received. Confirming your booking.",
      [
        "Payment received",
        "Payment received - confirming your booking",
        "Your payment went through. We're now confirming your reservation in our booking system - this usually takes a few seconds, please keep this page open. You won't be charged again.",
      ],
      "Checking automatically",
    ],
    [
      "attention",
      (mode) => answerOf(mode, "paid", { state: "needs_attention", reservationId: RESERVATION_ID }),
      `Payment received. We'll contact you about booking ${REF}.`,
      [
        "Payment received",
        "Payment received - we'll contact you",
        "Your payment went through, but your reservation needs a quick check by our team. Please don't pay again - Eldor will contact you shortly to confirm everything. You can also message us on WhatsApp with your booking reference.",
      ],
      RESERVATION_LINE,
    ],
    [
      "mismatch",
      (mode) => answerOf(mode, "failed", { state: "not_applicable", reservationId: null }, { failureCode: "AMOUNT_OR_REFERENCE_MISMATCH" }),
      "We need to check this payment. Please message us.",
      [
        `Booking ${REF}`,
        "We need to check this payment",
        "Something about this payment doesn't match your booking. Please don't pay again - message us with your booking reference and we'll sort it out.",
      ],
      "WhatsApp us",
    ],
  ];
  for (const [view, make, live, head, extra] of views) {
    for (const mode of ALL_MODES) {
      for (const email of [false, true]) {
        const label = `${view} ${mode} email=${email}`;
        const html = await render(propsFor(make(mode), mode, { sendsConfirmationEmail: email, cloudbedsWrites: "live" }));
        const c = chunks(html);
        const text = c.join(" ");
        if (view === "mismatch" && mode !== "demo") {
          // A failed answer is confirmed with the link's own status first (the server can't see the tab's link token).
          assert.equal(liveRegion(html), "Checking your payment.", label);
          continue;
        }
        assert.equal(liveRegion(html), live, label);
        assert.deepEqual(c.slice(1, 4), head, label);
        assert.ok(text.includes(extra) && text.includes("WhatsApp us"), `${label}: ${extra}`);
        assert.ok(!text.includes("Try again"), `${label}: never "Try again"`);
        assert.ok(!text.includes(SAVE_CALLOUT) && !c.includes(TERMS_HEADING), label);
        const note = previewNote(mode, "live");
        if (note) assert.ok(text.includes(note), `${label}: ${note}`);
        if (isBeam(mode)) assert.doesNotMatch(text, NO_RECEIPT_OR_STRIPE, label);
      }
    }
  }
});

/* --------------------------------------------- the unpaid views --------------------------------------------- */

test("design S5.3, the unpaid views' words: Stripe and the demo exactly as before; Beam takes Stripe's hold-first words (expired and cancelled are the design's guestCopy texts word for word, refunded as today) and a 'failed' that names no method", () => {
  assert.deepEqual(UNPAID_COPY, {
    failed: { title: "Payment didn't go through", body: "Nothing has been charged. You can try again with another card or PromptPay." },
    expired: { title: "Payment link expired", body: "Payment links last 30 minutes. Nothing has been charged - start the payment again when you're ready." },
    cancelled: { title: "Payment cancelled", body: "Nothing has been charged. Your reservation details are still saved in this browser." },
    refunded: { title: "Payment refunded", body: "This payment has been refunded. Message us if you weren't expecting this." },
  });
  assert.deepEqual(STRIPE_UNPAID_COPY, {
    failed: {
      title: "Payment didn't go through",
      body: "Nothing has been charged and the room hold was released. You can try again with another card, a wallet or PromptPay.",
    },
    expired: {
      title: "Payment time ran out",
      body: "Your room was held for 30 minutes while you paid and has now been released. Nothing has been charged - start again when you're ready.",
    },
    cancelled: {
      title: "Payment cancelled",
      body: "Nothing has been charged and the room hold was released. Your reservation details are still saved in this browser.",
    },
    refunded: { title: "Payment refunded", body: "This payment has been refunded. Message us if you weren't expecting this." },
  });
  // The design's guestCopy, title and text as one line.
  const guestCopy = {
    expired: "Payment time ran out. Your room was held for 30 minutes while you paid and has now been released. Nothing has been charged - start again when you're ready.",
    cancelled: "Payment cancelled. Nothing has been charged and the room hold was released. Your reservation details are still saved in this browser.",
  };
  const statuses: UnpaidStatus[] = ["failed", "expired", "cancelled", "refunded"];
  for (const status of statuses) {
    for (const mode of ALL_MODES) {
      const table = STRIPE_MODES.includes(mode) ? STRIPE_UNPAID_COPY : mode === "demo" ? UNPAID_COPY : BEAM_UNPAID_COPY;
      assert.deepEqual(unpaidCopy({ status, paymentMode: mode }), table[status], `${mode} ${status}`);
    }
    for (const mode of BEAM_MODES) {
      const copy = unpaidCopy({ status, paymentMode: mode });
      if (status === "expired" || status === "cancelled") assert.equal(`${copy.title}. ${copy.body}`, guestCopy[status], status);
      if (status === "refunded") assert.deepEqual(copy, UNPAID_COPY.refunded, "refunded as today");
      assert.doesNotMatch(`${copy.title} ${copy.body}`, NO_RECEIPT_OR_STRIPE);
    }
  }
  assert.deepEqual(BEAM_UNPAID_COPY.failed, {
    title: "Payment didn't go through",
    body: "Nothing has been charged and the room hold was released. You can try again with another card or another way to pay.",
  });
  // paid and pending never reach the unpaid view; the words fall back to 'failed' as before.
  for (const mode of ALL_MODES) for (const status of ["paid", "pending"] as const) assert.deepEqual(unpaidCopy({ status, paymentMode: mode }), unpaidCopy({ status: "failed", paymentMode: mode }));
});

test("design S5.3, 'Try again' only on expired, cancelled and failed - never on unconfirmed, refunded, a mismatch or a paid answer; the server render of an unpaid Stripe or Beam answer checks the link first, the demo shows its view as before", async () => {
  const cases: [string, PaymentStatus, FulfilmentView, Partial<StatusResponse>, boolean][] = [
    ["expired", "expired", { state: "released", reservationId: null }, {}, true],
    ["cancelled", "cancelled", { state: "released", reservationId: null }, {}, true],
    ["failed", "failed", { state: "released", reservationId: null }, { failureCode: "PAYMENT_FAILED" }, true],
    ["refunded", "refunded", { state: "not_applicable", reservationId: null }, {}, false],
    ["mismatch", "failed", { state: "not_applicable", reservationId: null }, { failureCode: "AMOUNT_OR_REFERENCE_MISMATCH" }, false],
    ["unconfirmed", "pending", { state: "released", reservationId: null }, { pendingReason: "unconfirmed" }, false],
    ["processing", "pending", { state: "awaiting_payment", reservationId: null }, { pendingReason: "processing" }, false],
    ["paid", "paid", CONFIRMED, {}, false],
    ["paid, needs attention", "paid", { state: "needs_attention", reservationId: RESERVATION_ID }, {}, false],
    ["paid, confirming", "paid", { state: "confirming", reservationId: null }, {}, false],
  ];
  for (const mode of ALL_MODES) {
    for (const [label, status, fulfilment, extra, retry] of cases) {
      const a = answerOf(mode, status, fulfilment, extra);
      assert.equal(canRetryPayment(a), retry, `${mode} ${label}`);
      if (returnViewKind(a) !== "unpaid") continue;
      const html = await render(propsFor(a, mode, { cloudbedsWrites: "mock" }));
      const text = textOf(html);
      if (mode === "demo") {
        // The demo has no link to check: its unpaid view at once, with "Try again" where it may pay again.
        const copy = unpaidCopy(a);
        assert.ok(text.includes(copy.title) && text.includes(copy.body), `${mode} ${label}\n${text}`);
        assert.equal(text.includes("Try again"), retry, `${mode} ${label}`);
      } else {
        // The server cannot see the tab's link token: "Checking your payment..." until the link's own status is read.
        assert.equal(liveRegion(html), "Checking your payment.", `${mode} ${label}`);
        assert.deepEqual(chunks(html).slice(1), ["Checking your payment...", "One moment while we look up your booking."], `${mode} ${label}`);
      }
    }
  }
});

/* ---------------------------------------------- the error views ---------------------------------------------- */

test("design S5.3, the error views and their preview note per page mode: Stripe and the demo as before; a beam-playground page's note says the reservation is made in Cloudbeds (or simulated), never that it would be in live mode", async () => {
  const errors: [string, StatusResponse | ApiError | null, string, string][] = [
    ["no token", null, "We couldn't find your booking details", "This page needs the link our payment page sends you back with."],
    ["invalid", { ok: false, error: "invalid_token", message: "This booking link is not valid." }, "This booking link isn't valid", "We can't check this link any more"],
    ["unavailable", { ok: false, error: "payment_unavailable", message: "We couldn't check this payment right now. Please refresh in a moment." }, "We couldn't check your payment", "We couldn't check this payment right now. Please refresh in a moment. If you've already paid, please don't pay again - message us with your booking reference."],
  ];
  for (const mode of ALL_MODES) {
    for (const writes of WRITES) {
      for (const [label, initial, title, body] of errors) {
        for (const showUnverifiedPreviewNote of [true, false]) {
          const props = { ...propsFor(initial, mode, { cloudbedsWrites: writes, showUnverifiedPreviewNote }), ...(initial ? {} : { token: null }) };
          const html = await render(props);
          const text = textOf(html);
          // Without a token the server can't know yet whether this tab saved the credentials: "Checking..." first.
          if (!initial) {
            assert.ok(text.includes("Checking your payment..."), `${mode} ${label}`);
            continue;
          }
          assert.ok(text.includes(title) && text.includes(body), `${mode} ${writes} ${label}\n${text}`);
          const note = previewNote(mode, writes);
          assert.equal(note !== null && text.includes(note), note !== null && showUnverifiedPreviewNote, `${mode} ${writes} ${label} note=${showUnverifiedPreviewNote}`);
          if (isBeam(mode)) assert.doesNotMatch(text, NO_RECEIPT_OR_STRIPE, `${mode} ${label}`);
        }
      }
    }
  }
});

/* ------------------------------------- both providers' real answers ------------------------------------- */

/** The Cloudbeds flags of a config, as returnPageCheck hands them to the page for a Beam answer. */
const flagsOf = (config: BookingConfig): PaidCopyFlags => ({ sendsConfirmationEmail: config.sendCloudbedsStatusEmail, cloudbedsWrites: config.cloudbedsWrite?.mode ?? "none" });

/** A 200 status answer. */
function okAnswer(r: { status: number; body: StatusResponse | ApiError }): StatusResponse {
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.ok);
  return r.body;
}

/** The return page's server render of `answer` with the flags of `config` (the config that answered it). */
async function pageOf(answer: StatusResponse | ApiError, config: BookingConfig): Promise<{ html: string; text: string }> {
  const html = await render(propsFor(answer, config.paymentMode, flagsOf(config)));
  return { html, text: textOf(html) };
}

test("design S5.3, both providers' real answers in every outcome (makeParityKit): held -> pending; paid -> the paid view with the reservation number; refunded before confirmation -> 'refunded' (no 'Try again'), for Beam also once fulfil wrote its marker (round 8); a late success after the release -> attention; abandoned -> cancelled with 'Try again'", async () => {
  for (const provider of ["stripe", "beam"] as const) {
    const fresh = (): ParityKit => makeParityKit(provider);
    const brand = provider === "beam" ? "Beam" : "Stripe";

    // Held: the payment page is open.
    let kit = fresh();
    const held = await kit.held();
    let a = okAnswer(await kit.status(held));
    assert.deepEqual([a.status, returnViewKind(a)], ["pending", "pending"], brand);
    let page = await pageOf(a, kit.config);
    assert.ok(page.text.includes(provider === "beam" ? `Confirming your payment... ${BEAM_PROCESSING}` : "Waiting for your payment..."), `${brand} held\n${page.text}`);

    // Paid: confirmed in Cloudbeds; the page shows its reservation number, and without the Cloudbeds email it is the confirmation.
    kit.pay(held);
    a = okAnswer(await kit.status(held));
    assert.deepEqual([a.status, a.fulfilment], ["paid", { state: "confirmed", reservationId: held.reservationId }], brand);
    page = await pageOf(a, kit.config);
    const flags = flagsOf(kit.config);
    const want = paidExpect(kit.config.paymentMode, flags.sendsConfirmationEmail, flags.cloudbedsWrites);
    assert.ok(page.text.includes(want.lead) && page.text.includes(want.email), `${brand} paid\n${page.text}`);
    assert.ok(page.text.includes(`Reservation number: ${held.reservationId}`), `${brand}: the Cloudbeds reservation number`);
    assert.equal(page.text.includes(SAVE_CALLOUT), want.pageIsConfirmation, brand);
    assert.equal(chunks(page.html).includes(TERMS_HEADING), want.pageIsConfirmation, brand);
    if (provider === "beam") assert.doesNotMatch(page.text, NO_RECEIPT_OR_STRIPE);

    // Refunded before anything confirmed it, read before any fulfil: "refunded", never "Try again", the same words.
    kit = fresh();
    const refunded = await kit.held();
    kit.pay(refunded);
    kit.refund(refunded);
    a = okAnswer(await kit.status(refunded));
    assert.equal(a.status, "refunded", brand);
    assert.equal(canRetryPayment(a), false, brand);
    assert.deepEqual(unpaidCopy(a), UNPAID_COPY.refunded, brand);

    // The refund seen only after fulfil wrote its marker: Beam answers the marker, which says the payment was refunded
    // before it was confirmed (round 8: "refunded", never "Payment received"); Stripe has no done shortcut and reads
    // the payment again (refunded). Neither offers "Try again".
    kit = fresh();
    const late = await kit.held();
    kit.pay(late);
    kit.refund(late);
    await kit.fulfil(late);
    a = okAnswer(await kit.status(late));
    if (provider === "beam") {
      assert.deepEqual([a.status, a.fulfilment, returnViewKind(a)], ["refunded", { state: "not_applicable", reservationId: null }, "unpaid"]);
      assert.equal(a.purchase, null);
      assert.deepEqual(unpaidCopy(a), UNPAID_COPY.refunded);
      // The server render of an unpaid answer checks the tab's link first ("Checking your payment..."): never "Payment received".
      page = await pageOf(a, kit.config);
      assert.ok(!page.text.includes("Payment received") && !page.text.includes("Try again"), page.text);
      assert.doesNotMatch(page.text, NO_RECEIPT_OR_STRIPE);
      // Answered from the marker, without a Beam call: the same words as before fulfil ran.
      const calls = kit.providerCalls();
      assert.equal(okAnswer(await kit.status(late)).status, "refunded");
      assert.equal(kit.providerCalls(), calls, "no Beam call for a finished booking");
    } else {
      assert.equal(a.status, "refunded");
    }
    assert.equal(canRetryPayment(a), false, brand);

    // A success after the hold was released (owner decision 3): paid, needs a person - the attention view.
    kit = fresh();
    const released = await kit.held();
    await kit.releaseUnpaid([released]);
    kit.payLate(released);
    a = okAnswer(await kit.status(released));
    assert.deepEqual([a.status, a.fulfilment.state, returnViewKind(a)], ["paid", "needs_attention", "attention"], brand);
    page = await pageOf(a, kit.config);
    assert.ok(page.text.includes("Payment received - we'll contact you") && !page.text.includes("Try again"), `${brand}\n${page.text}`);

    // Abandoned on the payment page: cancelled, the hold released, "Try again" - the same words for both.
    kit = fresh();
    const abandoned = await kit.held();
    assert.deepEqual((await kit.abandon(abandoned)).body, { ok: true, state: "released" }, brand);
    a = okAnswer(await kit.status(abandoned));
    assert.equal(a.status, "cancelled", brand);
    assert.equal(canRetryPayment(a), true, brand);
    assert.deepEqual(unpaidCopy(a), STRIPE_UNPAID_COPY.cancelled, brand);
  }
});

/** A Beam booking awaiting payment, made through the checkout route's path (beamRunCheckout). */
async function beamBooked(kit: BeamKit, payMethod: "card_ewallet" | "promptpay" = "card_ewallet") {
  const res = await beamRunCheckout(kit, undefined, { payMethod });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const body = res.body as CheckoutSuccess;
  const linkId = new URL(body.redirectUrl).pathname.split("/").pop() ?? "";
  const link = kit.fakeBeam.link(linkId);
  const t = new URL(link.redirectUrl ?? "").searchParams.get("t") ?? "";
  const v = verifyBookingToken(t, TOKEN_SECRET, kit.now.ms);
  assert.ok(v.ok && link.expiresAtMs !== null && body.holdReservationId);
  return { ref: body.ref, t, linkId, reservationId: body.holdReservationId, booking: v.payload.booking, expiresAt: link.expiresAtMs };
}

/** runStatus as the return page's server render asks it: the booking token, no link token (the pointer). */
function beamStatus(kit: BeamKit, t: string) {
  const providerDeps: ProviderDepsFn = (provider) => (provider === "beam" ? { deps: kit.deps, gw: kit.gw } : null);
  return runStatus({ t, p: null, l: null }, { config: kit.config, providerDeps, nowMs: kit.now.ms, log: kit.deps.log });
}

test("design S5.3, Beam's own outcomes from real answers (makeBeamKit): a PENDING PromptPay charge -> 'being confirmed'; still PENDING past the grace -> 'unconfirmed' (the hold released, don't pay again, no 'Try again'); expired -> the guestCopy words with 'Try again'; a token whose payMethod is not a group -> 'This booking link isn't valid'", async () => {
  // Processing, then unconfirmed once the window and the grace are over.
  const kit = makeBeamKit();
  const b = await beamBooked(kit, "promptpay");
  kit.fakeBeam.payPending(b.linkId, "QR_PROMPT_PAY");
  let a = okAnswer(await beamStatus(kit, b.t));
  assert.deepEqual([a.status, a.pendingReason], ["pending", "processing"]);
  let page = await pageOf(a, kit.config);
  assert.equal(liveRegion(page.html), "Confirming your payment. Please don't pay again.");
  assert.ok(page.text.includes(`Confirming your payment... ${BEAM_PROCESSING}`), page.text);
  kit.now.ms = b.expiresAt + GRACE_MS + MIN;
  a = okAnswer(await beamStatus(kit, b.t));
  assert.deepEqual([a.status, a.pendingReason, a.fulfilment.state], ["pending", "unconfirmed", "released"]);
  assert.equal(kit.fakeCb.reservations.get(b.reservationId)?.status, "canceled", "the hold was released");
  page = await pageOf(a, kit.config);
  assert.equal(liveRegion(page.html), "Waiting for your bank or wallet to confirm. Please don't pay again.");
  assert.ok(page.text.includes(`Waiting for your bank or wallet to confirm ${beamUnconfirmed(b.ref)}`), page.text);
  assert.ok(!page.text.includes("Try again") && !page.html.includes("resume=payment"), "never a new payment");
  assert.ok(!page.text.includes("Your room stays reserved"), "the room is no longer said to be held");
  assert.equal(canRetryPayment(a), false);

  // Expired with nothing paid: the hold released, the guestCopy words, "Try again".
  const kit2 = makeBeamKit();
  const e = await beamBooked(kit2);
  kit2.now.ms = e.expiresAt + 1;
  a = okAnswer(await beamStatus(kit2, e.t));
  assert.equal(a.status, "expired");
  assert.equal(canRetryPayment(a), true);
  const copy = unpaidCopy(a);
  assert.equal(
    `${copy.title}. ${copy.body}`,
    "Payment time ran out. Your room was held for 30 minutes while you paid and has now been released. Nothing has been charged - start again when you're ready.",
  );

  // Round 6 (c36059e): a Beam token whose payMethod is not one of the two groups -> 400 "This booking link is not valid."
  const forged = createBookingToken({ ...e.booking, payMethod: "bitcoin" as never }, null, TOKEN_SECRET, 3600, kit2.now.ms);
  const refused = await beamStatus(kit2, forged);
  assert.deepEqual([refused.status, refused.body], [400, { ok: false, error: "invalid_token", message: "This booking link is not valid." }]);
  page = await pageOf(refused.body, kit2.config);
  assert.ok(page.text.includes("This booking link isn't valid"), page.text);
  assert.doesNotMatch(page.text, NO_RECEIPT_OR_STRIPE);
});

/* ------------------------------ the server check: whose flags a Beam answer gets ------------------------------ */

/** runtime.ts's process-wide state (globalThis.__msvBookingRuntime). */
function runtimeGlobals(): Record<string, unknown> {
  const g = globalThis as typeof globalThis & { __msvBookingRuntime?: Record<string, unknown> };
  return (g.__msvBookingRuntime ??= {});
}

/** The first 3-night window from Jan 2027 (after `skip` others) where the demo calendar has `slug` free. */
function demoWindow(slug: string, skip: number): { checkIn: string; checkOut: string } {
  let found = 0;
  for (let i = 0; i < 300; i++) {
    const checkIn = addDays("2027-01-04", i * 4);
    const checkOut = addDays(checkIn, 3);
    if (buildOffers(demoInventory(checkIn, checkOut), 2).find((o) => o.slug === slug)?.available) {
      if (found === skip) return { checkIn, checkOut };
      found++;
    }
  }
  throw new Error(`no demo window for ${slug}`);
}

/** beam-playground with the MOCK writer and demo availability (a local run): the in-memory store, nothing leaves. */
const BEAM_ENV: Env = {
  BOOKING_PAYMENT_PROVIDER: "beam",
  BEAM_API_BASE: BEAM_PLAYGROUND_BASE,
  BEAM_MERCHANT_ID,
  BEAM_API_KEY,
  BEAM_WEBHOOK_HMAC_KEY: BEAM_HMAC_KEY_B64,
  BOOKING_TOKEN_SECRET: TOKEN_SECRET,
};

test("design S5.3 (round-6 amendment, 984acfc): the return page's server check gives a Beam answer the flags of the Beam config that answered it - also after a BOOKING_PAYMENT_PROVIDER typo, where the public config is the locked one (no email, no writes) and would show a paid guest the save/print callout although the Cloudbeds email is on its way; Stripe, demo and error answers carry none", async (t: TestContext) => {
  const savedEnv = process.env;
  const savedFetch = globalThis.fetch;
  const rt = runtimeGlobals();
  const savedGlobals = { ...rt };
  const network: string[] = [];
  try {
    globalThis.fetch = (async (input: string | URL | Request) => {
      network.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      throw new TypeError("network blocked by returnCopy.test.ts");
    }) as typeof fetch;
    hookReturnPage();
    const checkoutRoute = await import("../../app/api/booking/checkout/route.ts");
    const { returnPageCheck, returnPageStatus } = await import("./returnPageStatus.ts");
    t.mock.timers.enable({ apis: ["Date"], now: NOW });
    for (const level of ["info", "warn", "error"] as const) t.mock.method(console, level, () => undefined);
    for (const key of Object.keys(rt)) delete rt[key];
    const fakeBeam = createFakeBeam({ now: () => Date.now(), merchantId: BEAM_MERCHANT_ID, apiKey: BEAM_API_KEY, hmacKeyB64: BEAM_HMAC_KEY_B64, base: "playground" });
    const cloudbeds = createFakeCloudbeds({ lenient: true, now: () => Date.now() });
    rt.memoryKv = createMemoryKv(() => Date.now());
    rt.mockWriterCloudbeds = cloudbeds;
    rt.beamFetch = ((input: string | URL | Request, init?: RequestInit) => fakeBeam.fetch(input, init)) as typeof fetch;

    const headers = { host: "localhost:3000", "x-forwarded-for": "198.51.100.53", "content-type": "application/json" };
    const post = (body: unknown) => new Request("http://localhost:3000/api/booking/checkout", { method: "POST", headers, body: JSON.stringify(body) });
    let skip = 0;
    const bookAndPay = async (items: CartItemInput[]) => {
      const req = { ...demoWindow(items[0].slug, skip++), items, termsVersion: POLICY_VERSION, guest: GUEST, payMethod: "card_ewallet" };
      const quoted = await checkoutRoute.POST(post({ ...req, expectedTotalSatang: 1, expectedDueNowSatang: 1 }));
      assert.equal(quoted.status, 409);
      const { quote } = (await quoted.json()) as { quote: Quote };
      const res = await checkoutRoute.POST(post({ ...req, expectedTotalSatang: quote.totalSatang, expectedDueNowSatang: quote.dueNowSatang }));
      const body = (await res.json()) as CheckoutSuccess;
      assert.equal(res.status, 200, JSON.stringify(body));
      const linkId = new URL(body.redirectUrl).pathname.split("/").pop() ?? "";
      fakeBeam.pay(linkId, "CARD");
      return { t: new URL(fakeBeam.link(linkId).redirectUrl ?? "").searchParams.get("t") ?? "", reservationId: body.holdReservationId ?? "" };
    };

    for (const email of [undefined, "true"]) {
      const env: Env = { ...BEAM_ENV, ...(email ? { CLOUDBEDS_SEND_STATUS_EMAIL: email } : {}) };
      const typo: Env = { ...env, BOOKING_PAYMENT_PROVIDER: "bean" };
      const sends = email === "true";
      process.env = { ...env } as NodeJS.ProcessEnv;
      const b = await bookAndPay(email ? GARDEN : SUNRISE);
      const expected = { sendsConfirmationEmail: sends, cloudbedsWrites: "mock" as const };

      // The Beam deployment itself: the active config's flags, the same as its public config's.
      const own = await returnPageCheck(b.t, null, null);
      assert.ok(own.status.ok && own.status.status === "paid", JSON.stringify(own.status));
      assert.deepEqual(own.status.fulfilment, { state: "confirmed", reservationId: b.reservationId });
      assert.deepEqual(own.beamFlags, expected, `email=${email}`);
      assert.deepEqual(await returnPageStatus(b.t, null, null), own.status, "returnPageStatus is the check's status");
      const pub = getPublicBookingConfig(env);
      assert.deepEqual([pub.sendsBookingConfirmationEmail, pub.cloudbedsWrites], [sends, "mock"]);

      // After the typo: the Beam drain answers, with ITS flags; the public config is the locked one.
      process.env = { ...typo } as NodeJS.ProcessEnv;
      const fell = await returnPageCheck(b.t, null, null);
      assert.deepEqual(fell.status, own.status, "the same answer through the Beam drain");
      assert.deepEqual(fell.beamFlags, expected, `typo, email=${email}`);
      const locked = getPublicBookingConfig(typo);
      assert.deepEqual([locked.paymentStatus, locked.sendsBookingConfirmationEmail, locked.cloudbedsWrites], ["locked", false, "none"]);

      // What the page shows: with the check's flags (OwnReturnPage) the email decides; with the locked public config's
      // flags a guest whose Cloudbeds email is on its way would read that this page is the only confirmation.
      const answer = fell.status as StatusResponse;
      const shown = textOf(await render(propsFor(answer, "beam-playground", fell.beamFlags)));
      assert.equal(shown.includes(SAVE_CALLOUT), !sends, `typo, email=${email}`);
      assert.ok(shown.includes(previewNote("beam-playground", "mock") ?? "?"), "the drain's writes: simulated");
      const conservative = textOf(await render(propsFor(answer, "beam-playground", { sendsConfirmationEmail: locked.sendsBookingConfirmationEmail, cloudbedsWrites: locked.cloudbedsWrites })));
      assert.ok(conservative.includes(SAVE_CALLOUT), "the locked public config's view");
    }

    // Answers that are not Beam's carry no flags: an invalid token, and a demo booking on a demo deployment.
    process.env = { ...BEAM_ENV } as NodeJS.ProcessEnv;
    assert.deepEqual(await returnPageCheck("garbage", null, null), { status: { ok: false, error: "invalid_token", message: "This booking link is not valid." } });
    process.env = { BOOKING_TOKEN_SECRET: TOKEN_SECRET } as Env as NodeJS.ProcessEnv;
    const demoToken = createBookingToken(bookingOf("demo", { linkExpiresAt: new Date(NOW + 30 * MIN).toISOString() }), null, TOKEN_SECRET, 3600, NOW);
    const demo = await returnPageCheck(demoToken, null, null);
    assert.ok(demo.status.ok && demo.status.paymentMode === "demo" && demo.status.status === "pending", JSON.stringify(demo.status));
    assert.equal("beamFlags" in demo, false, "a demo answer keeps the public config's flags");
    assert.deepEqual(network, [], "nothing left the process");
  } finally {
    for (const key of Object.keys(rt)) delete rt[key];
    Object.assign(rt, savedGlobals);
    process.env = savedEnv;
    globalThis.fetch = savedFetch;
  }
});

/* ------------------------------------------------ the wiring ------------------------------------------------ */

test("design S5.3 wiring: OwnReturnPage passes a Beam answer's own flags (else the public config's); ReturnStatus shows Beam's paid view when beamPaidCopy has words for the mode, Beam's pending words from the reason the poll last read (no new round of checks), and the unpaid words from returnView.ts", () => {
  const read = (path: string) => readFileSync(new URL(`../../components/booking/${path}`, import.meta.url), "utf8");
  const page = read("OwnReturnPage.tsx");
  assert.ok(page.includes("return returnPageCheck(t, p, s);"));
  assert.ok(page.includes("const initial = check?.status ?? null;"));
  assert.ok(page.includes("const flags = check?.beamFlags ?? { cloudbedsWrites: config.cloudbedsWrites, sendsConfirmationEmail: config.sendsBookingConfirmationEmail };"));
  assert.ok(page.includes("cloudbedsWrites={flags.cloudbedsWrites}") && page.includes("sendsConfirmationEmail={flags.sendsConfirmationEmail}"));
  assert.ok(!page.includes("config.cloudbedsWrites}") && !page.includes("config.sendsBookingConfirmationEmail}"), "no prop reads the public config directly");

  const ret = read("return/ReturnStatus.tsx");
  assert.ok(ret.includes("const beamCopy = beamPaidCopy(result.paymentMode, { sendsConfirmationEmail, cloudbedsWrites });"));
  assert.match(ret, /view = beamCopy \? \(\s*<BeamPaidView result=\{result\} guestName=\{guestName\} copy=\{beamCopy\} cloudbedsWrites=\{cloudbedsWrites\} \/>\s*\) : \(\s*<PaidView /);
  assert.ok(ret.includes("const reservationId = isHoldFirstMode(result.paymentMode) ? result.fulfilment.reservationId : null;"), "Beam: hold-first from the mode");
  assert.ok(ret.includes("{copy.pageIsConfirmation && <SaveConfirmationCallout />}") && ret.includes("{copy.pageIsConfirmation && <BookingTerms booking={booking} />}"));
  assert.ok(ret.includes("const beam = beamPendingCopy(result, exhausted);"), "the pending view and the live region");
  assert.equal(ret.split("beamPendingCopy(result, exhausted)").length - 1, 2);
  // The poll: a new view kind replaces the result (and starts its own checks); a Beam reason change only updates the words.
  assert.match(ret, /if \(res\.ok && returnViewKind\(res\) !== kind\) \{\s*setResult\(res\);\s*return;\s*\}\s*(\/\/[^\n]*\n\s*)*const polled = res\.ok \? beamPolledReason\(res\) : null;\s*if \(polled\) setPolledReason\(\(prev\) => nextPolledReason\(prev, plan, polled\)\);/);
  assert.ok(ret.includes("useState<PolledReason | null>(null);"), "the kept reason is returnView.ts's PolledReason (round 8)");
  assert.match(ret, /const shown: Result =\s*result\?\.ok && result\.status === "pending" && polledReason !== null && polledReason\.plan === plan \? \{ \.\.\.result, pendingReason: polledReason\.reason \} : result;/);
  assert.ok(ret.includes("result={shown?.ok ? shown : result}") && ret.includes("statusAnnouncement(shown, exhausted)"));
  assert.ok(ret.includes("const copy = unpaidCopy(result);") && !ret.includes("const UNPAID_COPY"), "the unpaid words come from returnView.ts");
});
