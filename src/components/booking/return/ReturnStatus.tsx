"use client";

// OWNER: ui-checkout
// Return page after the payment page (Stripe Checkout, Beam, or the simulated
// / MOCK pages). The first status is verified on the server from the signed
// token (Stripe: from the Checkout Session itself, and a paid session is
// confirmed in Cloudbeds during that render); this component then shows the
// view returnViewKind() picks (lib/booking/returnView.ts):
//  - paid (confirmed): booking reference (+ the Cloudbeds reservation number
//    on Stripe), stay summary, what happens next, WhatsApp, "Add to
//    calendar" (.ics built in the browser); fires the GA4 purchase ONCE
//    (guarded per ref inside clientAnalytics; Stripe: only with the server's
//    purchase answer, i.e. live production + confirmed in Cloudbeds) and
//    clears the saved cart so it can't be paid twice.
//  - confirming (Stripe, paid): "Payment received - confirming your booking"
//    and keeps checking until Cloudbeds confirms.
//  - attention (Stripe, paid but needs a human): "Payment received - we'll
//    contact you" + WhatsApp. Never "Try again".
//  - pending: polls /api/booking/status (Stripe: every ~3 s for 3 minutes;
//    Beam: 1s, 2s, 4s ... 30s, about 2 minutes), then advises contacting us.
//  - mismatch: the payment doesn't match the booking - contact us only.
//  - failed / expired / cancelled / refunded: explains and offers
//    "Try again" back to the payment step (the cart is still saved).
// The guest's first name comes from this tab's sessionStorage, for display only (the email address is never shown).
// The signed token/proof are bearer credentials for the status API: on mount
// they move from the address bar into this tab's sessionStorage (so Reload
// and "Check again" still work) before the site's analytics tags load and
// record the page URL. The cleanup is an allow-list (theme, ?staff, ad-click
// ids), so whatever Beam might append to the redirect URL never reaches
// page_location either.
// The server render cannot see the Beam payment-link id (it lives in this
// tab's sessionStorage), so before any "Try again" view in a Beam mode the
// browser asks for the link's own status with it: a payment that just went
// through must never be offered a second charge.
// Keep ReturnStatusProps stable.

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { ReactNode } from "react";
import {
  BedDouble,
  CalendarPlus,
  CircleAlert,
  CircleCheck,
  CircleX,
  Clock,
  Copy,
  FlaskConical,
  LoaderCircle,
  Mail,
  MessageCircle,
  Plane,
  Printer,
  RefreshCw,
} from "lucide-react";
import { ADDONS, FREE_PICKUP_MIN_NIGHTS, HOUSE_POLICIES, RATE_PLANS, getCatalogueRoom } from "@/lib/booking/catalogue";
import { fetchStatus, recallLinkToken } from "@/lib/booking/apiClient";
import { isLiveMode, providerOf } from "@/lib/booking/payments/provider";
import { canRetryPayment, isPollingView, pollPlan, returnViewKind } from "@/lib/booking/returnView";
import type { ReturnViewKind } from "@/lib/booking/returnView";
import { createBookingAnalytics } from "@/lib/booking/clientAnalytics";
import { formatDisplayDateWithWeekday, formatNights } from "@/lib/booking/dates";
import { formatThbWithCode } from "@/lib/booking/format";
import { isBookingRef } from "@/lib/booking/ref";
import type { ApiError, BookingSummary, PaymentMode, PaymentStatus, StatusResponse, ThemeName } from "@/lib/booking/types";
import { allowListedSearch, resumePaymentPath } from "@/lib/booking/urls";
import type { ResumeReason } from "@/lib/booking/urls";
import { useHydrated } from "../hooks";
import { clearAttempt } from "../attempt";
import { clearPersistedCart, readPersistedBooking } from "../state";
import { whatsappHref } from "../checkout/PaymentMethodBadges";
import { site } from "@/data/site";
import { buildStayIcs, downloadIcs } from "./ics";

export interface ReturnStatusProps {
  /** ?ref (display only - the verified ref is initial.ref). */
  bookingRef: string | null;
  /** ?t signed booking token. */
  token: string | null;
  /** ?p signed demo proof (demo mode). */
  proof: string | null;
  /** Status verified on the server while rendering the page (null if no token). */
  initial: StatusResponse | ApiError | null;
  paymentMode: PaymentMode;
  /** Preview theme, kept on the "Try again" links. */
  theme?: ThemeName;
  /** Stripe: ?session_id (the Checkout Session id Stripe substitutes into the success URL). */
  sessionId?: string | null;
  /** The own booking page this return page belongs to ("/booking" or "/booking-preview"); "Try again" goes there. */
  bookingPath?: string;
  /** Whether a real Cloudbeds reservation is written in this mode (for the preview note). */
  cloudbedsWrites?: "live" | "mock" | "none";
  /** Stripe: whether Cloudbeds emails a booking confirmation (else Stripe's receipt is the only email). */
  sendsConfirmationEmail?: boolean;
  /**
   * Whether the error / unverified views may show the preview-mode note from
   * `paymentMode` (the CURRENT config, not a verified payment). Never on the
   * live /booking: during an emergency stop the config reads "demo", and a
   * guest who may have paid must not read "no real payment was taken".
   */
  showUnverifiedPreviewNote?: boolean;
}

type Result = StatusResponse | ApiError | null;

const RETRYABLE: ApiError["error"][] = ["upstream_error", "payment_unavailable", "network_error", "server_error", "rate_limited"];

const FAILURE_TEXT: Record<string, string> = {
  CH_CARD_DECLINED: "Your card was declined by the bank.",
  CH_INSUFFICIENT_FUNDS: "The card had insufficient funds.",
};

/** Latest return-page credentials in this tab (signed token + demo proof; no PII). */
const RETURN_CREDS_KEY = "msv_booking_return_v1";
const STATUS_TITLE_ID = "return-status-title";

interface ReturnCreds {
  ref: string | null;
  t: string;
  p: string | null;
  /** Stripe Checkout Session id (not secret on its own; the token is what authorises). */
  s?: string | null;
}

function saveReturnCreds(creds: ReturnCreds): void {
  try {
    sessionStorage.setItem(RETURN_CREDS_KEY, JSON.stringify(creds));
  } catch {
    // storage blocked: a reload simply can't recover the status
  }
}

function loadReturnCreds(): ReturnCreds | null {
  try {
    const raw = sessionStorage.getItem(RETURN_CREDS_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<ReturnCreds>;
    if (typeof v.t !== "string" || v.t.length === 0 || v.t.length > 4096) return null;
    return {
      t: v.t,
      p: typeof v.p === "string" && v.p.length <= 4096 ? v.p : null,
      ref: isBookingRef(v.ref) ? v.ref : null,
      s: typeof v.s === "string" && /^cs_[A-Za-z0-9_]{1,250}$/.test(v.s) ? v.s : null,
    };
  } catch {
    return null;
  }
}

/**
 * Allow-list cleanup of the address bar (see allowListedSearch): drops the
 * bearer token, proof and ref, and anything Beam may append to the redirect
 * URL (undocumented).
 */
function stripCredentialParams(): void {
  const url = new URL(window.location.href);
  const clean = allowListedSearch(url.search);
  if (url.search === clean) return;
  window.history.replaceState(window.history.state, "", url.pathname + clean + url.hash);
}

/**
 * Short screen-reader message for a status (one persistent live region reads
 * it). `exhausted`: automatic checking has stopped - said out loud too, since
 * the card changes only visually (WCAG 4.1.3).
 */
function statusAnnouncement(result: Result, exhausted = false): string {
  if (!result) return "";
  if (!result.ok) return result.error === "invalid_token" ? "This booking link isn't valid." : "We couldn't check your payment.";
  switch (returnViewKind(result)) {
    case "paid":
      return `Payment confirmed. Booking ${result.ref}.`;
    case "confirming":
      return exhausted
        ? "Payment received - still confirming. Please don't pay again. Use Check again, or message us on WhatsApp."
        : "Payment received. Confirming your booking.";
    case "attention":
      return `Payment received. We'll contact you about booking ${result.ref}.`;
    case "pending":
      return exhausted
        ? "This is taking longer than usual. Automatic checking has stopped - use Check again, or message us on WhatsApp."
        : brandOf(result) === "Stripe"
          ? "Waiting for your payment."
          : "Confirming your payment.";
    case "mismatch":
      return "We need to check this payment. Please message us.";
    case "unpaid": {
      // The view's own wording: a refunded payment WAS charged (and then refunded).
      const copy = unpaidCopy(result);
      return `${copy.title}. ${copy.body}`;
    }
  }
}

/** "Stripe" or "Beam" (the demo runs through the simulated Beam page). */
function brandOf(result: Pick<StatusResponse, "paymentMode">): "Stripe" | "Beam" {
  return providerOf(result.paymentMode) === "stripe" ? "Stripe" : "Beam";
}

const PRIMARY =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-(--bk-radius-pill) bg-(--bk-accent) px-5 text-sm font-semibold text-(--bk-accent-contrast) transition-colors hover:bg-(--bk-accent-hover) disabled:opacity-(--bk-disabled-opacity)";
const SECONDARY =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-(--bk-radius-pill) border border-(--bk-border-strong) bg-(--bk-surface) px-5 text-sm font-medium text-(--bk-text) transition-colors hover:border-(--bk-accent) disabled:opacity-(--bk-disabled-opacity)";

function helpHref(ref: string | null): string {
  return whatsappHref(
    ref ? `Hi, I have a question about my booking ${ref} on magicsamui.com.` : "Hi, I have a question about my booking on magicsamui.com.",
  );
}

/* ------------------------------ layout bits ------------------------------ */

function StatusCard({
  tone,
  icon,
  eyebrow,
  title,
  maskTitle = false,
  children,
}: {
  tone: "success" | "pending" | "danger" | "neutral";
  icon: ReactNode;
  eyebrow?: string;
  title: string;
  /** The title holds personal data (the guest's name): mask it in session recordings. */
  maskTitle?: boolean;
  children?: ReactNode;
}) {
  const ring =
    tone === "success"
      ? "bg-(--bk-success-soft) text-(--bk-success)"
      : tone === "danger"
        ? "bg-(--bk-danger-soft) text-(--bk-danger)"
        : tone === "pending"
          ? "bg-(--bk-accent-soft) text-(--bk-accent-soft-text)"
          : "bg-(--bk-surface-sunken) text-(--bk-text-muted)";
  return (
    <section className="rounded-(--bk-radius-card) bg-(--bk-surface) p-5 text-center shadow-(--bk-shadow-card) sm:p-8">
      <span className={`mx-auto inline-flex h-16 w-16 items-center justify-center rounded-full ${ring}`}>{icon}</span>
      {eyebrow && <p className="mt-4 text-xs font-semibold uppercase tracking-[0.25em] text-(--bk-eyebrow)">{eyebrow}</p>}
      <h1
        id={STATUS_TITLE_ID}
        tabIndex={-1}
        className="bk-heading mt-2 text-3xl text-(--bk-text) focus:outline-none"
        data-clarity-mask={maskTitle ? "true" : undefined}
      >
        {title}
      </h1>
      {children && <div className="mx-auto mt-3 max-w-xl text-(--bk-text-muted)">{children}</div>}
    </section>
  );
}

function PreviewModeNote({ paymentMode, cloudbedsWrites = "none" }: { paymentMode: PaymentMode; cloudbedsWrites?: "live" | "mock" | "none" }) {
  if (isLiveMode(paymentMode)) return null;
  let note: ReactNode;
  if (paymentMode === "stripe-mock") {
    note = (
      <>
        <strong>MOCK mode - nothing was charged.</strong> The Stripe checkout was fake and the Cloudbeds reservation was simulated.
      </>
    );
  } else if (paymentMode === "stripe-test") {
    note = (
      <>
        <strong>Stripe test mode - no real money moved.</strong>{" "}
        {cloudbedsWrites === "live"
          ? "A REAL Cloudbeds reservation was created for this test - check it, then cancel it in Cloudbeds."
          : "The Cloudbeds reservation was simulated."}
      </>
    );
  } else {
    note = (
      <>
        <strong>{paymentMode === "demo" ? "Demo mode - no real payment was taken." : "Beam test mode - no real money moved."}</strong> In
        live mode this is where the reservation would be created in Cloudbeds and confirmation emails sent.
      </>
    );
  }
  return (
    <div className="flex items-start gap-3 rounded-(--bk-radius-control) border border-(--bk-banner-border) bg-(--bk-banner-bg) p-4 text-sm text-(--bk-banner-text)">
      <FlaskConical size={18} aria-hidden="true" className="mt-0.5 shrink-0 text-(--bk-warning)" />
      <p>{note}</p>
    </div>
  );
}

/** The Cloudbeds reservation number (Stripe), shown under the booking reference. */
function ReservationNumber({ reservationId }: { reservationId: string | null }) {
  if (!reservationId) return null;
  return (
    <p className="mt-2 text-sm text-(--bk-text-muted)">
      Reservation number: <span className="font-mono font-semibold text-(--bk-text) select-all">{reservationId}</span>
    </p>
  );
}

function ReferenceBox({ bookingRef }: { bookingRef: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(bookingRef);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard blocked - the reference is selectable text anyway
    }
  }
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-(--bk-radius-control) border border-dashed border-(--bk-border-strong) bg-(--bk-surface-muted) px-4 py-3">
      <div className="text-left">
        <p className="text-xs uppercase tracking-wider text-(--bk-text-subtle)">Booking reference</p>
        <p className="font-mono text-xl font-semibold tracking-wide text-(--bk-text) select-all">{bookingRef}</p>
      </div>
      <button type="button" onClick={copy} className={SECONDARY}>
        <Copy size={15} aria-hidden="true" />
        <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
      </button>
    </div>
  );
}

function StaySummary({ booking }: { booking: BookingSummary }) {
  const balance = booking.totalSatang - booking.dueNowSatang;
  return (
    <section
      aria-labelledby="return-stay-title"
      className="rounded-(--bk-radius-card) bg-(--bk-surface) p-5 shadow-(--bk-shadow-card) sm:p-6"
    >
      <h2 id="return-stay-title" className="bk-heading text-xl text-(--bk-text)">
        Your stay
      </h2>
      <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-(--bk-text-subtle)">Check-in</dt>
          <dd className="font-medium text-(--bk-text)">{formatDisplayDateWithWeekday(booking.checkIn)}</dd>
          <dd className="text-xs text-(--bk-text-muted)">From 3:00 PM</dd>
        </div>
        <div>
          <dt className="text-(--bk-text-subtle)">Check-out</dt>
          <dd className="font-medium text-(--bk-text)">{formatDisplayDateWithWeekday(booking.checkOut)}</dd>
          <dd className="text-xs text-(--bk-text-muted)">By 11:00 AM</dd>
        </div>
      </dl>
      <p className="mt-2 text-sm text-(--bk-text-muted)">{formatNights(booking.nights)}</p>

      <ul className="mt-4 space-y-3 border-t border-(--bk-border) pt-4">
        {booking.items.map((item, i) => (
          <li key={`${item.slug}-${i}`} className="flex items-start gap-3 text-sm">
            <BedDouble size={18} aria-hidden="true" className="mt-0.5 shrink-0 text-(--bk-accent)" />
            <div className="min-w-0">
              <p className="font-medium text-(--bk-text)">{getCatalogueRoom(item.slug)?.name ?? item.slug}</p>
              <p className="text-(--bk-text-muted)">
                {RATE_PLANS[item.ratePlanId]?.name ?? item.ratePlanId} · {item.adults} {item.adults === 1 ? "guest" : "guests"}
                {item.addonIds.length > 0 && ` · ${item.addonIds.map((a) => ADDONS[a]?.name ?? a).join(", ")}`}
              </p>
            </div>
          </li>
        ))}
      </ul>

      <dl className="mt-4 space-y-1.5 border-t border-(--bk-border) pt-4 text-sm">
        {booking.promoCode && (
          <div className="flex justify-between gap-3 text-(--bk-text-muted)">
            <dt>Promo code</dt>
            <dd>{booking.promoCode}</dd>
          </div>
        )}
        {booking.cardFeeSatang > 0 && (
          <div className="flex justify-between gap-3 text-(--bk-text-muted)">
            <dt>Payment processing fee (included)</dt>
            <dd className="bk-price">{formatThbWithCode(booking.cardFeeSatang)}</dd>
          </div>
        )}
        <div className="flex justify-between gap-3 text-(--bk-text)">
          <dt>Total</dt>
          <dd className="bk-price">{formatThbWithCode(booking.totalSatang)}</dd>
        </div>
        <div className="flex justify-between gap-3 font-semibold text-(--bk-text)">
          <dt>Paid</dt>
          <dd className="bk-price">{formatThbWithCode(booking.dueNowSatang)}</dd>
        </div>
        {balance > 0 && (
          <div className="flex justify-between gap-3 text-(--bk-text-muted)">
            <dt>Balance due</dt>
            <dd className="bk-price">{formatThbWithCode(balance)}</dd>
          </div>
        )}
      </dl>
    </section>
  );
}

/* --------------------------------- views --------------------------------- */

/**
 * Stripe without a Cloudbeds confirmation email: this page IS the booking
 * confirmation, so it says so up front, next to its Print button.
 */
function SaveConfirmationCallout() {
  return (
    <div className="mt-4 flex flex-col items-start gap-3 rounded-(--bk-radius-control) border border-(--bk-accent) bg-(--bk-accent-soft) px-4 py-3 text-left text-sm text-(--bk-text) sm:flex-row sm:items-center sm:justify-between">
      <p className="min-w-0 sm:flex-1">
        <span className="font-semibold">Save or print this page - it is your booking confirmation.</span>{" "}
        {"It can't be reopened once you close this tab."}
      </p>
      <button type="button" onClick={() => window.print()} className={SECONDARY}>
        <Printer size={16} aria-hidden="true" />
        Print or save
      </button>
    </div>
  );
}

/** The terms the guest agreed to, plus how to reach us: printed with the page when it is the only confirmation. */
function BookingTerms({ booking }: { booking: BookingSummary }) {
  const phone = site.phones[0];
  return (
    <section aria-labelledby="return-terms-title" className="rounded-(--bk-radius-card) bg-(--bk-surface) p-5 shadow-(--bk-shadow-card) sm:p-6">
      <h2 id="return-terms-title" className="bk-heading text-xl text-(--bk-text)">
        Booking terms
      </h2>
      <dl className="mt-3 space-y-3 text-sm">
        <div>
          <dt className="font-medium text-(--bk-text)">Check-in and check-out</dt>
          <dd className="text-(--bk-text-muted)">
            {HOUSE_POLICIES.checkIn}. {HOUSE_POLICIES.checkOut}.
          </dd>
        </div>
        <div>
          <dt className="font-medium text-(--bk-text)">Cancellation</dt>
          <dd className="text-(--bk-text-muted)">{HOUSE_POLICIES.cancellation}</dd>
        </div>
        <div>
          <dt className="font-medium text-(--bk-text)">Children</dt>
          <dd className="text-(--bk-text-muted)">{HOUSE_POLICIES.children}</dd>
        </div>
        {booking.cardFeeSatang > 0 && (
          <div>
            <dt className="font-medium text-(--bk-text)">Payment processing fee</dt>
            <dd className="text-(--bk-text-muted)">{formatThbWithCode(booking.cardFeeSatang)}, included in the amount paid.</dd>
          </div>
        )}
        <div>
          <dt className="font-medium text-(--bk-text)">Property</dt>
          <dd className="text-(--bk-text-muted)">
            {site.name}, {site.address}
            <br />
            {phone ? (
              <>
                Phone / WhatsApp{" "}
                <a href={`tel:${phone.tel}`} className="font-medium text-(--bk-text) underline underline-offset-2">
                  {phone.number}
                </a>
                {" · "}
              </>
            ) : null}
            Email{" "}
            <a href={`mailto:${site.email}`} className="font-medium text-(--bk-text) underline underline-offset-2">
              {site.email}
            </a>
          </dd>
        </div>
      </dl>
    </section>
  );
}

function PaidView({
  result,
  guestName,
  cloudbedsWrites,
  sendsConfirmationEmail,
}: {
  result: StatusResponse;
  guestName: string | null;
  cloudbedsWrites: "live" | "mock" | "none";
  sendsConfirmationEmail: boolean;
}) {
  const { booking } = result;
  const live = isLiveMode(result.paymentMode);
  const stripe = providerOf(result.paymentMode) === "stripe";
  // Stripe without a Cloudbeds confirmation email: this page is the guest's booking confirmation.
  const pageIsConfirmation = stripe && !sendsConfirmationEmail;
  const reservationId = stripe ? result.fulfilment.reservationId : null;
  const pickup = booking.nights >= FREE_PICKUP_MIN_NIGHTS;
  const roomNames = booking.items.map((i) => getCatalogueRoom(i.slug)?.name ?? i.slug);

  function addToCalendar() {
    const ics = buildStayIcs({ ref: booking.ref, checkIn: booking.checkIn, checkOut: booking.checkOut, rooms: roomNames });
    downloadIcs(`${booking.ref}.ics`, ics);
  }

  return (
    <div className="space-y-5">
      <StatusCard
        tone="success"
        icon={<CircleCheck size={34} aria-hidden="true" />}
        eyebrow={live || stripe ? "Booking confirmed" : "Payment successful"}
        title={guestName ? `Thank you, ${guestName}!` : "Thank you!"}
        maskTitle={Boolean(guestName)}
      >
        {/* The guest's email address is never printed here (this is the page the purchase event fires on). */}
        <p>
          {live && stripe
            ? "Your stay is booked and paid. Stripe is emailing your payment receipt to the email address you entered."
            : live
              ? "Your stay is booked and paid. A confirmation email is on its way to the email address you entered."
              : stripe
                ? result.paymentMode === "stripe-mock"
                  ? "The MOCK payment went through and the simulated reservation is confirmed."
                  : `Your test payment went through and the reservation is confirmed${cloudbedsWrites === "live" ? " in Cloudbeds" : " (simulated)"}.`
                : "Your test payment went through - in live mode your stay would now be reserved."}
        </p>
        <div className="mt-5">
          <ReferenceBox bookingRef={booking.ref} />
          <ReservationNumber reservationId={reservationId} />
          {pageIsConfirmation && <SaveConfirmationCallout />}
        </div>
      </StatusCard>

      <PreviewModeNote paymentMode={result.paymentMode} cloudbedsWrites={cloudbedsWrites} />

      <StaySummary booking={booking} />

      {pageIsConfirmation && <BookingTerms booking={booking} />}

      <section
        aria-labelledby="return-next-title"
        className="rounded-(--bk-radius-card) bg-(--bk-surface) p-5 shadow-(--bk-shadow-card) sm:p-6"
      >
        <h2 id="return-next-title" className="bk-heading text-xl text-(--bk-text)">
          What happens next
        </h2>
        <ul className="mt-4 space-y-4 text-sm">
          <li className="flex gap-3">
            <Mail size={18} aria-hidden="true" className="mt-0.5 shrink-0 text-(--bk-accent)" />
            <p className="text-(--bk-text-muted)">
              <span className="font-medium text-(--bk-text)">{pageIsConfirmation ? "Payment receipt." : "Confirmation email."}</span>{" "}
              {live && stripe
                ? sendsConfirmationEmail
                  ? "Your booking confirmation and Stripe's payment receipt are sent to the email address you entered. Check your spam folder if they haven't arrived in a few minutes."
                  : "Stripe sends your payment receipt to the email address you entered; keep it with your booking reference and this page. Check your spam folder if the receipt hasn't arrived in a few minutes."
                : live
                  ? "Your confirmation and receipt are sent to the email address you entered. Check your spam folder if it hasn't arrived in a few minutes."
                  : stripe
                    ? "In live mode the guest receives Stripe's payment receipt by email and the reservation is confirmed in Cloudbeds."
                    : "In live mode the guest receives the Cloudbeds confirmation and Beam's receipt by email."}
            </p>
          </li>
          {pickup && (
            <li className="flex gap-3">
              <Plane size={18} aria-hidden="true" className="mt-0.5 shrink-0 text-(--bk-accent)" />
              <p className="text-(--bk-text-muted)">
                <span className="font-medium text-(--bk-text)">Free airport pickup.</span>{" "}
                Send us your flight number and arrival time on
                WhatsApp and we&apos;ll meet you at Samui airport.
              </p>
            </li>
          )}
          <li className="flex gap-3">
            <Clock size={18} aria-hidden="true" className="mt-0.5 shrink-0 text-(--bk-accent)" />
            <p className="text-(--bk-text-muted)">
              <span className="font-medium text-(--bk-text)">Arrival.</span> {HOUSE_POLICIES.checkIn},{" "}
              {HOUSE_POLICIES.checkOut.replace(/^Check-out/, "check-out")}. Arriving late? Just let us know.
            </p>
          </li>
          <li className="flex gap-3">
            <MessageCircle size={18} aria-hidden="true" className="mt-0.5 shrink-0 text-(--bk-accent)" />
            <p className="text-(--bk-text-muted)">
              <span className="font-medium text-(--bk-text)">Questions or special requests?</span> Message Eldor on WhatsApp with your
              booking reference.
            </p>
          </li>
        </ul>
        <div className="mt-5 flex flex-wrap gap-2">
          <a href={helpHref(booking.ref)} target="_blank" rel="noopener noreferrer" className={PRIMARY}>
            <MessageCircle size={16} aria-hidden="true" />
            WhatsApp us
          </a>
          <button type="button" onClick={() => window.print()} className={SECONDARY}>
            <Printer size={16} aria-hidden="true" />
            Print or save this confirmation
          </button>
          <button type="button" onClick={addToCalendar} className={SECONDARY}>
            <CalendarPlus size={16} aria-hidden="true" />
            Add to calendar
          </button>
          <Link href="/" className={SECONDARY}>
            Back to the website
          </Link>
        </div>
      </section>
    </div>
  );
}

function PendingView({
  result,
  exhausted,
  checking,
  onCheckAgain,
  theme,
  bookingPath,
  cloudbedsWrites,
}: {
  result: StatusResponse;
  exhausted: boolean;
  checking: boolean;
  onCheckAgain: () => void;
  theme: ThemeName | undefined;
  bookingPath: string;
  cloudbedsWrites: "live" | "mock" | "none";
}) {
  const brand = brandOf(result);
  return (
    <div className="space-y-5">
      <StatusCard
        tone="pending"
        icon={exhausted ? <Clock size={30} aria-hidden="true" /> : <LoaderCircle size={30} aria-hidden="true" className="animate-spin" />}
        eyebrow="Payment pending"
        title={exhausted ? "This is taking longer than usual" : brand === "Stripe" ? "Waiting for your payment..." : "Confirming your payment..."}
      >
        {exhausted ? (
          <p>
            {`We haven't had the confirmation from ${brand} yet. If money has left your account, please don't pay again - message us with your reference and we'll confirm your booking.`}
          </p>
        ) : brand === "Stripe" ? (
          <p>
            We&apos;re waiting for Stripe to confirm your payment. Once you&apos;ve paid this usually takes a few seconds (a PromptPay
            payment can take a little longer) - please keep this page open. Your room stays reserved meanwhile.
          </p>
        ) : (
          <p>Beam is confirming your payment with your bank. This usually takes a few seconds - please keep this page open.</p>
        )}
        <div className="mt-5">
          <ReferenceBox bookingRef={result.ref} />
        </div>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          {/* While a check runs the button stays focusable (aria-disabled) so keyboard focus isn't dropped. */}
          <button
            type="button"
            onClick={() => {
              if (!checking) onCheckAgain();
            }}
            disabled={!exhausted}
            aria-disabled={checking || undefined}
            aria-busy={checking || undefined}
            className={exhausted ? PRIMARY : SECONDARY}
          >
            <RefreshCw size={16} aria-hidden="true" className={checking ? "animate-spin" : undefined} />
            {exhausted ? "Check again" : "Checking automatically"}
          </button>
          <a href={helpHref(result.ref)} target="_blank" rel="noopener noreferrer" className={SECONDARY}>
            <MessageCircle size={16} aria-hidden="true" />
            WhatsApp us
          </a>
          {exhausted && (
            // Never "Try again" here: the payment may have gone through. The booking page warns before paying again.
            <a href={resumePaymentPath("unverified", theme, result.ref, bookingPath)} className={SECONDARY}>
              Back to your booking
            </a>
          )}
        </div>
      </StatusCard>
      <PreviewModeNote paymentMode={result.paymentMode} cloudbedsWrites={cloudbedsWrites} />
    </div>
  );
}

/**
 * Stripe, paid: the payment is in, the Cloudbeds reservation is being
 * confirmed (webhook, this page or the sweeper). Never offers a new payment.
 */
function ConfirmingView({
  result,
  exhausted,
  checking,
  onCheckAgain,
  cloudbedsWrites,
}: {
  result: StatusResponse;
  exhausted: boolean;
  checking: boolean;
  onCheckAgain: () => void;
  cloudbedsWrites: "live" | "mock" | "none";
}) {
  return (
    <div className="space-y-5">
      <StatusCard
        tone="pending"
        icon={exhausted ? <Clock size={30} aria-hidden="true" /> : <LoaderCircle size={30} aria-hidden="true" className="animate-spin" />}
        eyebrow="Payment received"
        title={exhausted ? "Payment received - still confirming" : "Payment received - confirming your booking"}
      >
        {exhausted ? (
          <p>
            Your payment went through, but confirming the reservation is taking longer than usual. Please don&apos;t pay again - we&apos;ve
            been alerted and will confirm your booking by email or WhatsApp. You can also message us with your reference.
          </p>
        ) : (
          <p>
            Your payment went through. We&apos;re now confirming your reservation in our booking system - this usually takes a few seconds,
            please keep this page open. You won&apos;t be charged again.
          </p>
        )}
        <div className="mt-5">
          <ReferenceBox bookingRef={result.ref} />
        </div>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <button
            type="button"
            onClick={() => {
              if (!checking) onCheckAgain();
            }}
            disabled={!exhausted}
            aria-disabled={checking || undefined}
            aria-busy={checking || undefined}
            className={exhausted ? PRIMARY : SECONDARY}
          >
            <RefreshCw size={16} aria-hidden="true" className={checking ? "animate-spin" : undefined} />
            {exhausted ? "Check again" : "Checking automatically"}
          </button>
          <a href={helpHref(result.ref)} target="_blank" rel="noopener noreferrer" className={SECONDARY}>
            <MessageCircle size={16} aria-hidden="true" />
            WhatsApp us
          </a>
        </div>
      </StatusCard>
      <PreviewModeNote paymentMode={result.paymentMode} cloudbedsWrites={cloudbedsWrites} />
    </div>
  );
}

/** Paid, but the reservation needs a human (e.g. the hold was released before the payment landed). Never "Try again". */
function AttentionView({ result, cloudbedsWrites }: { result: StatusResponse; cloudbedsWrites: "live" | "mock" | "none" }) {
  return (
    <div className="space-y-5">
      <StatusCard
        tone="neutral"
        icon={<CircleAlert size={32} aria-hidden="true" />}
        eyebrow="Payment received"
        title="Payment received - we'll contact you"
      >
        <p>
          Your payment went through, but your reservation needs a quick check by our team. Please don&apos;t pay again - Eldor will
          contact you shortly to confirm everything. You can also message us on WhatsApp with your booking reference.
        </p>
        <div className="mt-5">
          <ReferenceBox bookingRef={result.ref} />
          <ReservationNumber reservationId={result.fulfilment.reservationId} />
        </div>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <a href={helpHref(result.ref)} target="_blank" rel="noopener noreferrer" className={PRIMARY}>
            <MessageCircle size={16} aria-hidden="true" />
            WhatsApp us
          </a>
        </div>
      </StatusCard>
      <StaySummary booking={result.booking} />
      <PreviewModeNote paymentMode={result.paymentMode} cloudbedsWrites={cloudbedsWrites} />
    </div>
  );
}

/** The payment found doesn't match this booking (amount, currency or reference). Contact us only. */
function MismatchView({ result, cloudbedsWrites }: { result: StatusResponse; cloudbedsWrites: "live" | "mock" | "none" }) {
  return (
    <div className="space-y-5">
      <StatusCard
        tone="neutral"
        icon={<CircleAlert size={32} aria-hidden="true" />}
        eyebrow={`Booking ${result.ref}`}
        title="We need to check this payment"
      >
        <p>
          Something about this payment doesn&apos;t match your booking. Please don&apos;t pay again - message us with your booking reference
          and we&apos;ll sort it out.
        </p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <a href={helpHref(result.ref)} target="_blank" rel="noopener noreferrer" className={PRIMARY}>
            <MessageCircle size={16} aria-hidden="true" />
            WhatsApp us
          </a>
        </div>
      </StatusCard>
      <PreviewModeNote paymentMode={result.paymentMode} cloudbedsWrites={cloudbedsWrites} />
    </div>
  );
}

const UNPAID_COPY: Record<Exclude<PaymentStatus, "paid" | "pending">, { title: string; body: string }> = {
  failed: { title: "Payment didn't go through", body: "Nothing has been charged. You can try again with another card or PromptPay." },
  expired: {
    title: "Payment link expired",
    body: "Payment links last 30 minutes. Nothing has been charged - start the payment again when you're ready.",
  },
  cancelled: { title: "Payment cancelled", body: "Nothing has been charged. Your reservation details are still saved in this browser." },
  refunded: { title: "Payment refunded", body: "This payment has been refunded. Message us if you weren't expecting this." },
};

/** Stripe wording: the room was held while the guest paid, and is released when the payment doesn't happen. */
const STRIPE_UNPAID_COPY: Record<Exclude<PaymentStatus, "paid" | "pending">, { title: string; body: string }> = {
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
  refunded: UNPAID_COPY.refunded,
};

function unpaidCopy(result: Pick<StatusResponse, "status" | "paymentMode">): { title: string; body: string } {
  const status = result.status === "paid" || result.status === "pending" ? "failed" : result.status;
  return (providerOf(result.paymentMode) === "stripe" ? STRIPE_UNPAID_COPY : UNPAID_COPY)[status];
}

const RESUME_REASON: Record<Exclude<PaymentStatus, "paid" | "pending">, ResumeReason> = {
  failed: "failed",
  expired: "expired",
  cancelled: "cancelled",
  refunded: "failed",
};

function UnpaidView({
  result,
  theme,
  bookingPath,
  cloudbedsWrites,
}: {
  result: StatusResponse & { status: Exclude<PaymentStatus, "paid" | "pending"> };
  theme: ThemeName | undefined;
  bookingPath: string;
  cloudbedsWrites: "live" | "mock" | "none";
}) {
  const copy = unpaidCopy(result);
  const reason = result.failureCode ? FAILURE_TEXT[result.failureCode] : null;
  return (
    <div className="space-y-5">
      <StatusCard tone="danger" icon={<CircleX size={34} aria-hidden="true" />} eyebrow={`Booking ${result.ref}`} title={copy.title}>
        <p>
          {reason ? `${reason} ` : ""}
          {copy.body}
        </p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          {canRetryPayment(result) && (
            <a href={resumePaymentPath(RESUME_REASON[result.status], theme, result.ref, bookingPath)} className={PRIMARY}>
              <RefreshCw size={16} aria-hidden="true" />
              Try again
            </a>
          )}
          <a href={helpHref(result.ref)} target="_blank" rel="noopener noreferrer" className={SECONDARY}>
            <MessageCircle size={16} aria-hidden="true" />
            WhatsApp us
          </a>
        </div>
      </StatusCard>
      <PreviewModeNote paymentMode={result.paymentMode} cloudbedsWrites={cloudbedsWrites} />
    </div>
  );
}

function ErrorView({
  error,
  bookingRef,
  checking,
  onCheckAgain,
  theme,
  bookingPath,
}: {
  error: ApiError | null;
  bookingRef: string | null;
  checking: boolean;
  onCheckAgain: (() => void) | null;
  theme: ThemeName | undefined;
  bookingPath: string;
}) {
  const title = !error
    ? "We couldn't find your booking details"
    : error.error === "invalid_token"
      ? "This booking link isn't valid"
      : "We couldn't check your payment";
  const body = !error
    ? "This page needs the link our payment page sends you back with. If you've just paid, your booking is safe: please message us with your booking reference, and don't pay again."
    : error.error === "invalid_token"
      ? "We can't check this link any more - it may be incomplete or older than 2 days. If you've already paid, your booking is safe: message us with your booking reference, and please don't pay again."
      : `${error.message} If you've already paid, please don't pay again - message us with your booking reference.`;
  // An unverified ?ref is only echoed when it is a well-formed reference.
  const ref = isBookingRef(bookingRef) ? bookingRef : null;
  return (
    <StatusCard
      tone="neutral"
      icon={<CircleAlert size={32} aria-hidden="true" />}
      eyebrow={ref ? `Booking ${ref}` : undefined}
      title={title}
    >
      <p>{body}</p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        {onCheckAgain && (
          <button
            type="button"
            onClick={() => {
              if (!checking) onCheckAgain();
            }}
            aria-disabled={checking || undefined}
            aria-busy={checking || undefined}
            className={PRIMARY}
          >
            <RefreshCw size={16} aria-hidden="true" className={checking ? "animate-spin" : undefined} />
            Check again
          </button>
        )}
        <a href={resumePaymentPath("unverified", theme, ref, bookingPath)} className={onCheckAgain ? SECONDARY : PRIMARY}>
          Back to your booking
        </a>
        <a href={helpHref(ref)} target="_blank" rel="noopener noreferrer" className={SECONDARY}>
          <MessageCircle size={16} aria-hidden="true" />
          WhatsApp us
        </a>
      </div>
    </StatusCard>
  );
}

/* ------------------------------- component ------------------------------- */

export default function ReturnStatus({
  bookingRef: urlRef,
  token: urlToken,
  proof: urlProof,
  initial,
  paymentMode,
  theme,
  sessionId: urlSessionId = null,
  bookingPath = "/booking-preview",
  cloudbedsWrites = "none",
  sendsConfirmationEmail = false,
  showUnverifiedPreviewNote = true,
}: ReturnStatusProps) {
  const [result, setResult] = useState<Result>(initial);
  const [exhausted, setExhausted] = useState(false);
  const [checking, setChecking] = useState(false);
  const hydrated = useHydrated();

  // Credentials from the URL, or - after a reload once they left the address
  // bar - from this tab's sessionStorage.
  const saved = useMemo(() => (hydrated && !urlToken ? loadReturnCreds() : null), [hydrated, urlToken]);
  const token = urlToken ?? saved?.t ?? null;
  const proof = urlToken ? urlProof : (saved?.p ?? null);
  const bookingRef = urlToken ? urlRef : (saved?.ref ?? urlRef);
  const sessionId = urlToken ? urlSessionId : (saved?.s ?? null);
  // Before hydration a page without a URL token can't know yet whether this tab saved the
  // credentials (a reload after paying): show "Checking..." rather than a frightening error.
  const recovering = (Boolean(saved) || (!hydrated && !urlToken)) && result === null;

  // A terminal unpaid answer from the server render (which can't see the Beam
  // link id) is confirmed with the link's own status before "Try again" is
  // offered. Until hydration shows whether this tab holds the link token, and
  // while that check runs, the page says "Checking your payment...".
  const needsLinkCheck =
    initial?.ok === true && initial.paymentMode !== "demo" && initial.status !== "paid" && initial.status !== "pending";
  const linkToken = useMemo(
    () => (hydrated && needsLinkCheck && initial?.ok ? recallLinkToken(initial.ref) : null),
    [hydrated, needsLinkCheck, initial],
  );
  const [linkChecked, setLinkChecked] = useState(false);
  const awaitingLinkCheck = needsLinkCheck && !linkChecked && (!hydrated || linkToken !== null);

  useEffect(() => {
    if (!linkToken || !urlToken || linkChecked) return;
    const controller = new AbortController();
    fetchStatus({ t: urlToken, p: urlProof, l: linkToken, s: urlSessionId }, controller.signal)
      .then((res) => {
        // A failed check shows the retryable error (with the "don't pay twice" way back), never the stale terminal view.
        setResult(res);
        setLinkChecked(true);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [linkToken, urlToken, urlProof, urlSessionId, linkChecked]);

  useEffect(() => {
    if (urlToken) {
      saveReturnCreds({ t: urlToken, p: urlProof, ref: initial?.ok ? initial.ref : isBookingRef(urlRef) ? urlRef : null, s: urlSessionId });
    }
    stripCredentialParams();
    // Once, on mount: the server's values for this load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reload after the cleanup: re-check the status from the saved credentials.
  useEffect(() => {
    if (!saved || result !== null) return;
    const controller = new AbortController();
    fetchStatus({ t: saved.t, p: saved.p, l: saved.ref ? recallLinkToken(saved.ref) : null, s: saved.s ?? null }, controller.signal)
      .then((res) => setResult(res))
      .catch(() => undefined);
    return () => controller.abort();
  }, [saved, result]);

  // Status changes after the first render: move focus to the new heading (the
  // persistent live region below announces it).
  const kind: ReturnViewKind | null = result?.ok ? returnViewKind(result) : null;
  // `exhausted` is part of the key on the polling views: when automatic checking stops, focus moves to the new heading.
  const statusKey = result ? (result.ok ? `${result.status}:${kind}${kind !== null && isPollingView(kind) && exhausted ? ":exhausted" : ""}` : result.error) : "none";
  const lastStatusKey = useRef(statusKey);
  useEffect(() => {
    if (lastStatusKey.current === statusKey) return;
    lastStatusKey.current = statusKey;
    document.getElementById(STATUS_TITLE_ID)?.focus({ preventScroll: false });
  }, [statusKey]);

  const verifiedRef = result?.ok ? result.ref : null;
  // pending (waiting for the payment) and confirming (Stripe: paid, Cloudbeds confirmation running) keep checking.
  const polling = kind !== null && isPollingView(kind);
  const plan = useMemo(() => (result?.ok ? pollPlan(result) : null), [result]);
  const paid = result?.ok === true && result.status === "paid" ? result : null;

  // Display-only guest details saved by the booking flow in this tab (never sent anywhere).
  const guest = useMemo(() => (hydrated ? (readPersistedBooking()?.guest ?? null) : null), [hydrated]);
  const guestName = guest?.firstName.trim() || null;

  // Poll while the payment (or, on Stripe, the Cloudbeds confirmation) is still running. Stripe: every
  // ~3 s for 3 minutes; Beam: 1s, then 2s, 4s, 8s ... capped at 30s, for about 2 minutes (pollPlan).
  useEffect(() => {
    if (!polling || !plan || !token || exhausted || kind === null) return;
    const controller = new AbortController();
    const startedAt = Date.now();
    let attempt = 0;
    let timer: number | undefined;

    const tick = async () => {
      attempt += 1;
      let res: StatusResponse | ApiError;
      try {
        res = await fetchStatus({ t: token, p: proof, l: verifiedRef ? recallLinkToken(verifiedRef) : null, s: sessionId }, controller.signal);
      } catch {
        return; // aborted
      }
      if (controller.signal.aborted) return;
      if (res.ok && returnViewKind(res) !== kind) {
        setResult(res);
        return;
      }
      if (Date.now() - startedAt >= plan.maxMs) {
        setExhausted(true);
        return;
      }
      timer = window.setTimeout(tick, plan.nextMs(attempt));
    };

    timer = window.setTimeout(tick, plan.firstMs);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [polling, plan, kind, token, proof, verifiedRef, sessionId, exhausted]);

  // Payment received: drop the saved cart (and this tab's checkout attempt) so it can't be paid twice,
  // and record the purchase once. Stripe: clientAnalytics sends it only with the server's purchase
  // answer (live production + confirmed in Cloudbeds; transaction_id = the Cloudbeds reservation id).
  useEffect(() => {
    if (!paid) return;
    createBookingAnalytics(paid.paymentMode).purchase(paid.booking, paid.purchase);
    clearPersistedCart();
    clearAttempt(paid.ref);
  }, [paid]);

  // A terminal unpaid answer for this tab's last Stripe attempt: nothing left to release.
  useEffect(() => {
    if (result?.ok && (kind === "unpaid" || kind === "mismatch")) clearAttempt(result.ref);
  }, [result, kind]);

  async function checkAgain() {
    if (!token || checking) return;
    setChecking(true);
    const ref = verifiedRef ?? bookingRef;
    const res = await fetchStatus({ t: token, p: proof, l: ref ? recallLinkToken(ref) : null, s: sessionId });
    setChecking(false);
    if (res.ok) {
      setResult(res);
      // Still waiting: start another round of automatic checks.
      if (isPollingView(returnViewKind(res))) setExhausted(false);
    } else if (!result?.ok) {
      setResult(res);
    }
  }

  let view: ReactNode;
  if (recovering || awaitingLinkCheck) {
    view = (
      <StatusCard tone="pending" icon={<LoaderCircle size={30} aria-hidden="true" className="animate-spin" />} title="Checking your payment...">
        <p>One moment while we look up your booking.</p>
      </StatusCard>
    );
  } else if (!result || !result.ok) {
    const retryable = Boolean(token && result && RETRYABLE.includes(result.error));
    view = (
      <div className="space-y-5">
        <ErrorView
          error={result}
          bookingRef={bookingRef}
          checking={checking}
          onCheckAgain={retryable ? checkAgain : null}
          theme={theme}
          bookingPath={bookingPath}
        />
        {showUnverifiedPreviewNote && <PreviewModeNote paymentMode={paymentMode} cloudbedsWrites={cloudbedsWrites} />}
      </div>
    );
  } else if (kind === "paid") {
    view = (
      <PaidView result={result} guestName={guestName} cloudbedsWrites={cloudbedsWrites} sendsConfirmationEmail={sendsConfirmationEmail} />
    );
  } else if (kind === "confirming") {
    view = <ConfirmingView result={result} exhausted={exhausted} checking={checking} onCheckAgain={checkAgain} cloudbedsWrites={cloudbedsWrites} />;
  } else if (kind === "attention") {
    view = <AttentionView result={result} cloudbedsWrites={cloudbedsWrites} />;
  } else if (kind === "mismatch") {
    view = <MismatchView result={result} cloudbedsWrites={cloudbedsWrites} />;
  } else if (result.status === "pending") {
    view = (
      <PendingView
        result={result}
        exhausted={exhausted}
        checking={checking}
        onCheckAgain={checkAgain}
        theme={theme}
        bookingPath={bookingPath}
        cloudbedsWrites={cloudbedsWrites}
      />
    );
  } else if (result.status === "paid") {
    // Unreachable (every paid answer has a view above); never fall through to "Try again".
    view = <AttentionView result={result} cloudbedsWrites={cloudbedsWrites} />;
  } else {
    view = <UnpaidView result={{ ...result, status: result.status }} theme={theme} bookingPath={bookingPath} cloudbedsWrites={cloudbedsWrites} />;
  }

  return (
    <>
      {/* One persistent live region: a region that mounts already filled (each view's own card) is often not read. */}
      {/* "Checking..." while a manual check runs, then the status again, so the result is read out. */}
      <p role="status" className="bk-sr-only">
        {recovering || awaitingLinkCheck ? "Checking your payment." : checking ? "Checking..." : statusAnnouncement(result, exhausted)}
      </p>
      {view}
    </>
  );
}
