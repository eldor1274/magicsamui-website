"use client";

// OWNER: ui-checkout
// Return page after Beam (or the simulated Beam page). The first status is
// verified on the server from the signed token; this component then:
//  - paid: booking reference, stay summary, what happens next, WhatsApp,
//    "Add to calendar" (.ics built in the browser); fires the GA4 purchase
//    ONCE (guarded per ref inside clientAnalytics, and gated to live
//    production) and clears the saved cart so it can't be paid twice.
//  - pending: polls /api/booking/status with backoff (1s, 2s, 4s ... 30s,
//    about 2 minutes in all), then advises contacting us.
//  - failed / expired / cancelled / refunded: explains and offers
//    "Try again" back to the payment step (the cart is still saved).
// Guest name/email come from this tab's sessionStorage, for display only.
// Keep ReturnStatusProps stable.

import { useEffect, useMemo, useState } from "react";
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
  RefreshCw,
} from "lucide-react";
import { ADDONS, FREE_PICKUP_MIN_NIGHTS, HOUSE_POLICIES, RATE_PLANS, getCatalogueRoom } from "@/lib/booking/catalogue";
import { fetchStatus, recallLinkToken } from "@/lib/booking/apiClient";
import { createBookingAnalytics } from "@/lib/booking/clientAnalytics";
import { formatDisplayDateWithWeekday, formatNights } from "@/lib/booking/dates";
import { formatThbWithCode } from "@/lib/booking/format";
import type { ApiError, BookingSummary, PaymentMode, PaymentStatus, StatusResponse } from "@/lib/booking/types";
import { useHydrated } from "../hooks";
import { clearPersistedCart, readPersistedBooking } from "../state";
import { whatsappHref } from "../checkout/PaymentMethodBadges";
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
}

type Result = StatusResponse | ApiError | null;

const POLL_FIRST_MS = 1_000;
const POLL_BASE_MS = 2_000;
const POLL_CAP_MS = 30_000;
const POLL_MAX_MS = 120_000;
const RETRY_PATH = "/booking-preview?resume=payment";
const RETRYABLE: ApiError["error"][] = ["upstream_error", "payment_unavailable", "network_error", "server_error", "rate_limited"];

const FAILURE_TEXT: Record<string, string> = {
  CH_CARD_DECLINED: "Your card was declined by the bank.",
  CH_INSUFFICIENT_FUNDS: "The card had insufficient funds.",
};

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
  children,
}: {
  tone: "success" | "pending" | "danger" | "neutral";
  icon: ReactNode;
  eyebrow?: string;
  title: string;
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
    <section className="rounded-(--bk-radius-card) bg-(--bk-surface) p-5 text-center shadow-(--bk-shadow-card) sm:p-8" aria-live="polite">
      <span className={`mx-auto inline-flex h-16 w-16 items-center justify-center rounded-full ${ring}`}>{icon}</span>
      {eyebrow && <p className="mt-4 text-xs font-semibold uppercase tracking-[0.25em] text-(--bk-eyebrow)">{eyebrow}</p>}
      <h1 className="bk-heading mt-2 text-3xl text-(--bk-text)">{title}</h1>
      {children && <div className="mx-auto mt-3 max-w-xl text-(--bk-text-muted)">{children}</div>}
    </section>
  );
}

function PreviewModeNote({ paymentMode }: { paymentMode: PaymentMode }) {
  if (paymentMode === "beam-live") return null;
  return (
    <div className="flex items-start gap-3 rounded-(--bk-radius-control) border border-(--bk-banner-border) bg-(--bk-banner-bg) p-4 text-sm text-(--bk-banner-text)">
      <FlaskConical size={18} aria-hidden="true" className="mt-0.5 shrink-0 text-(--bk-warning)" />
      <p>
        <strong>{paymentMode === "demo" ? "Demo mode - no real payment was taken." : "Beam test mode - no real money moved."}</strong> In
        live mode this is where the reservation would be created in Cloudbeds and confirmation emails sent.
      </p>
    </div>
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
            <dt>Card processing fee (included)</dt>
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

function PaidView({ result, guestName, guestEmail }: { result: StatusResponse; guestName: string | null; guestEmail: string | null }) {
  const { booking } = result;
  const live = result.paymentMode === "beam-live";
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
        eyebrow={live ? "Booking confirmed" : "Payment successful"}
        title={guestName ? `Thank you, ${guestName}!` : "Thank you!"}
      >
        <p>
          {live
            ? `Your stay is booked and paid.${guestEmail ? ` A confirmation email is on its way to ${guestEmail}.` : ""}`
            : "Your payment went through and your stay is reserved in this preview."}
        </p>
        <div className="mt-5">
          <ReferenceBox bookingRef={booking.ref} />
        </div>
      </StatusCard>

      <PreviewModeNote paymentMode={result.paymentMode} />

      <StaySummary booking={booking} />

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
              <span className="font-medium text-(--bk-text)">Confirmation email.</span>{" "}
              {live
                ? `Your confirmation and receipt are sent${guestEmail ? ` to ${guestEmail}` : " by email"}. Check your spam folder if it hasn't arrived in a few minutes.`
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
}: {
  result: StatusResponse;
  exhausted: boolean;
  checking: boolean;
  onCheckAgain: () => void;
}) {
  return (
    <div className="space-y-5">
      <StatusCard
        tone="pending"
        icon={exhausted ? <Clock size={30} aria-hidden="true" /> : <LoaderCircle size={30} aria-hidden="true" className="animate-spin" />}
        eyebrow="Payment pending"
        title={exhausted ? "This is taking longer than usual" : "Confirming your payment..."}
      >
        {exhausted ? (
          <p>
            We haven&apos;t had the confirmation from Beam yet. If money has left your account, please don&apos;t pay again - message us
            with your reference and we&apos;ll confirm your booking.
          </p>
        ) : (
          <p>Beam is confirming your payment with your bank. This usually takes a few seconds - please keep this page open.</p>
        )}
        <div className="mt-5">
          <ReferenceBox bookingRef={result.ref} />
        </div>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <button type="button" onClick={onCheckAgain} disabled={checking || !exhausted} className={exhausted ? PRIMARY : SECONDARY}>
            <RefreshCw size={16} aria-hidden="true" className={checking ? "animate-spin" : undefined} />
            {exhausted ? "Check again" : "Checking automatically"}
          </button>
          <a href={helpHref(result.ref)} target="_blank" rel="noopener noreferrer" className={SECONDARY}>
            <MessageCircle size={16} aria-hidden="true" />
            WhatsApp us
          </a>
        </div>
      </StatusCard>
      <PreviewModeNote paymentMode={result.paymentMode} />
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

function UnpaidView({ result }: { result: StatusResponse & { status: Exclude<PaymentStatus, "paid" | "pending"> } }) {
  const copy = UNPAID_COPY[result.status];
  const reason = result.failureCode ? FAILURE_TEXT[result.failureCode] : null;
  return (
    <div className="space-y-5">
      <StatusCard tone="danger" icon={<CircleX size={34} aria-hidden="true" />} eyebrow={`Booking ${result.ref}`} title={copy.title}>
        <p>
          {reason ? `${reason} ` : ""}
          {copy.body}
        </p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          {result.status !== "refunded" && (
            <a href={RETRY_PATH} className={PRIMARY}>
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
      <PreviewModeNote paymentMode={result.paymentMode} />
    </div>
  );
}

function ErrorView({
  error,
  bookingRef,
  checking,
  onCheckAgain,
}: {
  error: ApiError | null;
  bookingRef: string | null;
  checking: boolean;
  onCheckAgain: (() => void) | null;
}) {
  const title = !error
    ? "We couldn't find your booking details"
    : error.error === "invalid_token"
      ? "This booking link isn't valid"
      : "We couldn't check your payment";
  const body = !error
    ? "This page needs the link Beam sends you back with. If you've just paid, please message us with your booking reference."
    : error.message;
  return (
    <StatusCard
      tone="neutral"
      icon={<CircleAlert size={32} aria-hidden="true" />}
      eyebrow={bookingRef ? `Booking ${bookingRef}` : undefined}
      title={title}
    >
      <p>{body}</p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        {onCheckAgain && (
          <button type="button" onClick={onCheckAgain} disabled={checking} className={PRIMARY}>
            <RefreshCw size={16} aria-hidden="true" className={checking ? "animate-spin" : undefined} />
            Check again
          </button>
        )}
        <a href={RETRY_PATH} className={onCheckAgain ? SECONDARY : PRIMARY}>
          Back to your booking
        </a>
        <a href={helpHref(bookingRef)} target="_blank" rel="noopener noreferrer" className={SECONDARY}>
          <MessageCircle size={16} aria-hidden="true" />
          WhatsApp us
        </a>
      </div>
    </StatusCard>
  );
}

/* ------------------------------- component ------------------------------- */

export default function ReturnStatus({ bookingRef, token, proof, initial, paymentMode }: ReturnStatusProps) {
  const [result, setResult] = useState<Result>(initial);
  const [exhausted, setExhausted] = useState(false);
  const [checking, setChecking] = useState(false);
  const hydrated = useHydrated();

  const verifiedRef = result?.ok ? result.ref : null;
  const pending = result?.ok === true && result.status === "pending";
  const paid = result?.ok === true && result.status === "paid" ? result : null;

  // Display-only guest details saved by the booking flow in this tab (never sent anywhere).
  const guest = useMemo(() => (hydrated ? (readPersistedBooking()?.guest ?? null) : null), [hydrated]);
  const guestName = guest?.firstName.trim() || null;
  const guestEmail = guest?.email.trim() || null;

  // Poll while Beam has not confirmed yet: 1s, then 2s, 4s, 8s ... capped at 30s, for about 2 minutes.
  useEffect(() => {
    if (!pending || !token || exhausted) return;
    const controller = new AbortController();
    const startedAt = Date.now();
    let attempt = 0;
    let timer: number | undefined;

    const tick = async () => {
      attempt += 1;
      let res: StatusResponse | ApiError;
      try {
        res = await fetchStatus({ t: token, p: proof, l: verifiedRef ? recallLinkToken(verifiedRef) : null }, controller.signal);
      } catch {
        return; // aborted
      }
      if (controller.signal.aborted) return;
      if (res.ok && res.status !== "pending") {
        setResult(res);
        return;
      }
      if (Date.now() - startedAt >= POLL_MAX_MS) {
        setExhausted(true);
        return;
      }
      timer = window.setTimeout(tick, Math.min(POLL_BASE_MS * 2 ** (attempt - 1), POLL_CAP_MS));
    };

    timer = window.setTimeout(tick, POLL_FIRST_MS);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [pending, token, proof, verifiedRef, exhausted]);

  // Confirmed payment: record the purchase once and drop the saved cart.
  useEffect(() => {
    if (!paid) return;
    createBookingAnalytics(paid.paymentMode).purchase(paid.booking);
    clearPersistedCart();
  }, [paid]);

  async function checkAgain() {
    if (!token || checking) return;
    setChecking(true);
    const ref = verifiedRef ?? bookingRef;
    const res = await fetchStatus({ t: token, p: proof, l: ref ? recallLinkToken(ref) : null });
    setChecking(false);
    if (res.ok) {
      setResult(res);
      // Still pending: start another round of automatic checks.
      if (res.status === "pending") setExhausted(false);
    } else if (!result?.ok) {
      setResult(res);
    }
  }

  if (!result || !result.ok) {
    const retryable = Boolean(token && result && RETRYABLE.includes(result.error));
    return (
      <div className="space-y-5">
        <ErrorView error={result} bookingRef={bookingRef} checking={checking} onCheckAgain={retryable ? checkAgain : null} />
        <PreviewModeNote paymentMode={paymentMode} />
      </div>
    );
  }

  switch (result.status) {
    case "paid":
      return <PaidView result={result} guestName={guestName} guestEmail={guestEmail} />;
    case "pending":
      return <PendingView result={result} exhausted={exhausted} checking={checking} onCheckAgain={checkAgain} />;
    default:
      return <UnpaidView result={{ ...result, status: result.status }} />;
  }
}
