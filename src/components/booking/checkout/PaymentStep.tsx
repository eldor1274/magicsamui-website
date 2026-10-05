"use client";

// OWNER: ui-checkout
// "Review and pay": stay, rooms and guest review with edit links, the amount
// due now, accepted methods and the pay button. Paying POSTs the cart (no
// prices) to /api/booking/checkout via BookingApp's pay(), which re-quotes on
// the server and does a top-level redirect to Beam's hosted page (or the
// simulated one in demo mode). Every checkout error has its own recovery.
// Keep PaymentStepProps stable.

import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import {
  ArrowRight,
  BedDouble,
  CalendarDays,
  CircleAlert,
  FlaskConical,
  LoaderCircle,
  Lock,
  MessageCircle,
  Pencil,
  RefreshCw,
  ShieldCheck,
  User,
} from "lucide-react";
import { HOUSE_POLICIES, getCatalogueRoom } from "@/lib/booking/catalogue";
import { formatDisplayDateWithWeekday, formatNights } from "@/lib/booking/dates";
import { formatThb, formatThbWithCode } from "@/lib/booking/format";
import type { GuestDetails } from "@/lib/booking/guest";
import type { CartItem, IsoDate, PaymentMode, Quote } from "@/lib/booking/types";
import type { CheckoutErrorView } from "../state";
import { TOUCH_TARGET } from "../ui/styles";
import PaymentMethodBadges, { whatsappHref } from "./PaymentMethodBadges";
import { getCountry } from "./countries";

export interface PaymentStepProps {
  quote: Quote;
  cart: CartItem[];
  guest: GuestDetails;
  checkIn: IsoDate;
  checkOut: IsoDate;
  paymentMode: PaymentMode;
  paymentStatus: "ok" | "locked";
  /** True while the checkout request runs or the redirect is happening. */
  submitting: boolean;
  error: CheckoutErrorView | null;
  onPay: () => void;
  onEditGuest: () => void;
  onEditRooms: () => void;
  /** Optional: back to the Add-ons step (offered when an add-on is what the server refused). */
  onEditAddons?: () => void;
}

const HELP_MESSAGE = "Hi, I'm trying to book on magicsamui.com but the payment step isn't working - can you help?";

function roomName(slug: string): string {
  return getCatalogueRoom(slug)?.name ?? slug;
}

const LINK_BUTTON = `${TOUCH_TARGET} inline-flex items-center gap-1 rounded-(--bk-radius-pill) px-2 py-1 text-sm font-medium text-(--bk-accent-soft-text) underline-offset-2 hover:underline`;
const SECONDARY_BUTTON =
  "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-(--bk-radius-pill) border border-(--bk-border-strong) bg-(--bk-surface) px-4 text-sm font-medium text-(--bk-text) transition-colors hover:border-(--bk-accent)";

function ReviewSection({
  icon: Icon,
  title,
  action,
  children,
}: {
  icon: typeof User;
  title: string;
  /** `ariaLabel` names the target ("Edit rooms") so two "Edit" buttons are distinguishable. */
  action?: { label: string; ariaLabel?: string; onClick: () => void; disabled?: boolean };
  children: ReactNode;
}) {
  return (
    <section className="border-b border-(--bk-border) py-4 first:pt-0 last:border-b-0">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-(--bk-text-subtle)">
          <Icon size={15} aria-hidden="true" />
          {title}
        </h3>
        {action && (
          <button
            type="button"
            onClick={action.onClick}
            disabled={action.disabled}
            aria-label={action.ariaLabel}
            className={`${LINK_BUTTON} disabled:opacity-(--bk-disabled-opacity)`}
          >
            <Pencil size={13} aria-hidden="true" />
            {action.label}
          </button>
        )}
      </div>
      {children}
    </section>
  );
}

interface ErrorPanelProps {
  error: CheckoutErrorView;
  quote: Quote;
  submitting: boolean;
  onPay: () => void;
  onEditRooms: () => void;
  onEditAddons?: () => void;
  onShowAmount: () => void;
}

function ErrorPanel({ error, quote, submitting, onPay, onEditRooms, onEditAddons, onShowAmount }: ErrorPanelProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, [error]);

  let title = "Payment could not be started";
  let body: ReactNode = error.message;
  let actions: ReactNode = null;

  switch (error.code) {
    case "unavailable": {
      const names = (error.unavailableSlugs ?? []).map(roomName);
      const forParty = error.occupancySlugs ?? [];
      if (forParty.length > 0 && forParty.length === names.length) {
        // Not sold: Cloudbeds won't take this many guests in that room online.
        title = "Too many guests for online booking";
        body = <>{error.message} Nothing has been charged.</>;
        actions = (
          <button type="button" onClick={onEditRooms} className={SECONDARY_BUTTON}>
            <BedDouble size={15} aria-hidden="true" />
            Choose rooms again
          </button>
        );
        break;
      }
      title = names.length === 1 ? "This room was just booked" : "Some rooms were just booked";
      body = (
        <>
          {names.length > 0 ? (
            <>
              Sorry - <strong>{names.join(", ")}</strong> {names.length === 1 ? "is" : "are"} no longer available for your dates.
            </>
          ) : (
            error.message
          )}{" "}
          Nothing has been charged.
        </>
      );
      actions = (
        <button type="button" onClick={onEditRooms} className={SECONDARY_BUTTON}>
          <BedDouble size={15} aria-hidden="true" />
          Choose another room
        </button>
      );
      break;
    }
    case "price_changed": {
      const updated =
        error.newTotalSatang !== undefined &&
        error.newTotalSatang === quote.totalSatang &&
        (error.newDueNowSatang === undefined || error.newDueNowSatang === quote.dueNowSatang);
      const dueNowDiffers = error.newDueNowSatang !== undefined && error.newDueNowSatang !== error.newTotalSatang;
      title = "The price has changed";
      body = (
        <>
          Prices for your dates were updated since you started.
          {error.newTotalSatang !== undefined && (
            <>
              {" "}
              The new total is <strong className="bk-price">{formatThbWithCode(error.newTotalSatang)}</strong>
              {dueNowDiffers && error.newDueNowSatang !== undefined && (
                <>
                  , of which <strong className="bk-price">{formatThbWithCode(error.newDueNowSatang)}</strong> is due now
                </>
              )}
              .
            </>
          )}{" "}
          {updated ? "Your summary now shows the new price - please review it and pay again." : "We're refreshing your summary."} Nothing
          has been charged.
        </>
      );
      actions = (
        <button type="button" onClick={onShowAmount} className={SECONDARY_BUTTON}>
          Review new price
        </button>
      );
      break;
    }
    case "promo_invalid":
      title = "Promo code not accepted";
      actions = (
        <button type="button" onClick={onEditRooms} className={SECONDARY_BUTTON}>
          Change code
        </button>
      );
      break;
    case "invalid_request":
      title = "Something in your reservation needs a look";
      if (error.issues && error.issues.length > 0) {
        body = (
          <>
            {error.issues.length === 1 ? (
              error.issues[0]
            ) : (
              <ul className="list-disc pl-5">
                {error.issues.slice(0, 4).map((issue, i) => (
                  <li key={i}>{issue}</li>
                ))}
              </ul>
            )}{" "}
            Nothing has been charged.
          </>
        );
      }
      actions =
        error.fixStep === "addons" && onEditAddons ? (
          <button type="button" onClick={onEditAddons} className={SECONDARY_BUTTON}>
            <Pencil size={15} aria-hidden="true" />
            Review add-ons
          </button>
        ) : (
          <button type="button" onClick={onEditRooms} className={SECONDARY_BUTTON}>
            <BedDouble size={15} aria-hidden="true" />
            Review rooms
          </button>
        );
      break;
    case "live_payments_locked":
    case "payment_unavailable":
      title = "Online payment is unavailable right now";
      body = <>{error.message} Nothing has been charged. Message us on WhatsApp and we&apos;ll complete the booking for you.</>;
      actions = (
        <a href={whatsappHref(HELP_MESSAGE)} target="_blank" rel="noopener noreferrer" className={SECONDARY_BUTTON}>
          <MessageCircle size={15} aria-hidden="true" />
          WhatsApp us
        </a>
      );
      break;
    case "rate_limited":
    case "network_error":
    case "upstream_error":
    case "server_error":
    default:
      title = error.code === "network_error" ? "Connection problem" : "Payment could not be started";
      body = <>{error.message} Nothing has been charged.</>;
      actions = (
        <>
          <button
            type="button"
            onClick={() => {
              if (!submitting) onPay();
            }}
            aria-disabled={submitting || undefined}
            className={`${SECONDARY_BUTTON} aria-disabled:opacity-(--bk-disabled-opacity)`}
          >
            <RefreshCw size={15} aria-hidden="true" />
            Try again
          </button>
          <a href={whatsappHref(HELP_MESSAGE)} target="_blank" rel="noopener noreferrer" className={SECONDARY_BUTTON}>
            <MessageCircle size={15} aria-hidden="true" />
            WhatsApp us
          </a>
        </>
      );
  }

  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="alert"
      className="rounded-(--bk-radius-control) border border-(--bk-danger) bg-(--bk-danger-soft) p-4 text-sm text-(--bk-text) focus:outline-none"
    >
      <div className="flex items-start gap-3">
        <CircleAlert size={20} aria-hidden="true" className="mt-0.5 shrink-0 text-(--bk-danger)" />
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-(--bk-danger)">{title}</p>
          <div className="mt-1 leading-relaxed">{body}</div>
          {actions && <div className="mt-3 flex flex-wrap gap-2">{actions}</div>}
        </div>
      </div>
    </div>
  );
}

export default function PaymentStep({
  quote,
  cart,
  guest,
  checkIn,
  checkOut,
  paymentMode,
  paymentStatus,
  submitting,
  error,
  onPay,
  onEditGuest,
  onEditRooms,
  onEditAddons,
}: PaymentStepProps) {
  const amountRef = useRef<HTMLDivElement>(null);
  const locked = paymentStatus === "locked";
  const country = getCountry(guest.country);
  const dueNow = formatThbWithCode(quote.dueNowSatang);

  function showAmount() {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    amountRef.current?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
    amountRef.current?.focus({ preventScroll: true });
  }

  return (
    <div className="space-y-4">
      {error && (
        <ErrorPanel
          error={error}
          quote={quote}
          submitting={submitting}
          onPay={onPay}
          onEditRooms={onEditRooms}
          onEditAddons={onEditAddons}
          onShowAmount={showAmount}
        />
      )}

      <div className="rounded-(--bk-radius-card) bg-(--bk-surface) p-4 shadow-(--bk-shadow-card) sm:p-6">
        <ReviewSection icon={CalendarDays} title="Your stay">
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-(--bk-text-subtle)">Check-in</dt>
              <dd className="font-medium text-(--bk-text)">{formatDisplayDateWithWeekday(checkIn)}</dd>
              <dd className="text-xs text-(--bk-text-muted)">From 3:00 PM</dd>
            </div>
            <div>
              <dt className="text-(--bk-text-subtle)">Check-out</dt>
              <dd className="font-medium text-(--bk-text)">{formatDisplayDateWithWeekday(checkOut)}</dd>
              <dd className="text-xs text-(--bk-text-muted)">By 11:00 AM</dd>
            </div>
          </dl>
          <p className="mt-2 text-sm text-(--bk-text-muted)">{formatNights(quote.nights)}</p>
        </ReviewSection>

        <ReviewSection
          icon={BedDouble}
          title={cart.length === 1 ? "Your room" : "Your rooms"}
          action={{ label: "Edit", ariaLabel: cart.length === 1 ? "Edit room" : "Edit rooms", onClick: onEditRooms, disabled: submitting }}
        >
          <ul className="space-y-3">
            {quote.lines.map((line, i) => (
              <li key={cart[i]?.id ?? `${line.slug}-${i}`} className="text-sm">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium text-(--bk-text)">{line.roomName}</p>
                    <p className="text-(--bk-text-muted)">
                      {line.ratePlanName} · {line.adults} {line.adults === 1 ? "guest" : "guests"} · {formatNights(line.nights)}
                    </p>
                  </div>
                  <p className="bk-price shrink-0 font-medium text-(--bk-text)">{formatThb(line.roomSatang)}</p>
                </div>
                {line.addons.map((a) => (
                  <div key={a.addonId} className="mt-1 flex items-start justify-between gap-3 pl-3 text-(--bk-text-muted)">
                    <p>
                      + {a.name} ({a.eligibleNights.length} {a.eligibleNights.length === 1 ? "night" : "nights"} × {a.guests})
                    </p>
                    <p className="bk-price shrink-0">{formatThb(a.amountSatang)}</p>
                  </div>
                ))}
              </li>
            ))}
          </ul>
        </ReviewSection>

        <ReviewSection
          icon={User}
          title="Lead guest"
          action={{ label: "Edit", ariaLabel: "Edit lead guest details", onClick: onEditGuest, disabled: submitting }}
        >
          {/* Personal data: masked in Microsoft Clarity session recordings (site-wide script). */}
          <div className="text-sm" data-clarity-mask="true">
            <p className="font-medium text-(--bk-text)">
              {guest.firstName} {guest.lastName}
            </p>
            <p className="break-all text-(--bk-text-muted)">{guest.email}</p>
            <p className="text-(--bk-text-muted)">
              {guest.dialCode} {guest.phone}
              {country ? ` · ${country.name}` : ""}
            </p>
          </div>
        </ReviewSection>

        <div
          ref={amountRef}
          tabIndex={-1}
          className="mt-2 rounded-(--bk-radius-control) bg-(--bk-surface-muted) p-4 focus:outline-none focus-visible:outline-2"
        >
          <dl className="space-y-1.5 text-sm">
            <div className="flex justify-between gap-3 text-(--bk-text-muted)">
              <dt>Rooms</dt>
              <dd className="bk-price">{formatThb(quote.roomsSubtotalSatang)}</dd>
            </div>
            {quote.addonsSubtotalSatang > 0 && (
              <div className="flex justify-between gap-3 text-(--bk-text-muted)">
                <dt>Add-ons</dt>
                <dd className="bk-price">{formatThb(quote.addonsSubtotalSatang)}</dd>
              </div>
            )}
            {quote.promo && (
              <div className="flex justify-between gap-3 text-(--bk-success)">
                <dt>{quote.promo.label}</dt>
                <dd className="bk-price">-{formatThb(quote.promo.discountSatang)}</dd>
              </div>
            )}
            {quote.cardFeeSatang > 0 && (
              <div className="flex justify-between gap-3 text-(--bk-text-muted)">
                <dt>Payment processing fee ({quote.cardFeePct}%)</dt>
                <dd className="bk-price">{formatThb(quote.cardFeeSatang)}</dd>
              </div>
            )}
            <div className="flex justify-between gap-3 border-t border-(--bk-border) pt-2 font-semibold text-(--bk-text)">
              <dt>Total</dt>
              <dd className="bk-price">{formatThbWithCode(quote.totalSatang)}</dd>
            </div>
          </dl>
          <div className="mt-3 flex items-end justify-between gap-3 border-t border-(--bk-border) pt-3">
            <div>
              <p className="text-sm font-semibold text-(--bk-text)">Due now</p>
              {quote.balanceSatang > 0 && (
                <p className="text-xs text-(--bk-text-muted)">Balance {formatThbWithCode(quote.balanceSatang)} later</p>
              )}
            </div>
            <p className="bk-price text-2xl font-semibold text-(--bk-text)" aria-live="polite">
              {dueNow}
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-4 rounded-(--bk-radius-card) bg-(--bk-surface) p-4 shadow-(--bk-shadow-card) sm:p-6">
        <div>
          <h3 className="bk-heading text-lg text-(--bk-text)">Pay securely with Beam</h3>
          <p className="mt-1 text-sm text-(--bk-text-muted)">
            You&apos;ll go to Beam&apos;s secure payment page to pay by card or Thai PromptPay QR, then come straight back here with your
            booking reference. Card details are entered on Beam&apos;s PCI DSS compliant page - never on our site.
          </p>
          <PaymentMethodBadges className="mt-3" />
        </div>

        {locked ? (
          <div className="flex items-start gap-3 rounded-(--bk-radius-control) border border-(--bk-danger) bg-(--bk-danger-soft) p-4 text-sm">
            <Lock size={18} aria-hidden="true" className="mt-0.5 shrink-0 text-(--bk-danger)" />
            <div>
              <p className="font-semibold text-(--bk-danger)">Payments are locked</p>
              <p className="mt-1 text-(--bk-text)">
                The payment settings for this preview are incomplete, so paying is disabled and nothing can be charged.{" "}
                <a href={whatsappHref(HELP_MESSAGE)} target="_blank" rel="noopener noreferrer" className="font-medium underline">
                  WhatsApp us
                </a>{" "}
                to book.
              </p>
            </div>
          </div>
        ) : paymentMode === "demo" ? (
          <div className="flex items-start gap-3 rounded-(--bk-radius-control) border border-(--bk-banner-border) bg-(--bk-warning-soft) p-4 text-sm text-(--bk-text)">
            <FlaskConical size={18} aria-hidden="true" className="mt-0.5 shrink-0 text-(--bk-warning)" />
            <p>
              <strong>Demo mode:</strong> the next page is a <strong>simulated</strong> Beam checkout. Use a Beam test card such as{" "}
              <span className="whitespace-nowrap">4111 1111 1111 1111</span> - no real payment is taken and no reservation is made.
            </p>
          </div>
        ) : paymentMode === "beam-playground" ? (
          <div className="flex items-start gap-3 rounded-(--bk-radius-control) border border-(--bk-banner-border) bg-(--bk-warning-soft) p-4 text-sm text-(--bk-text)">
            <FlaskConical size={18} aria-hidden="true" className="mt-0.5 shrink-0 text-(--bk-warning)" />
            <p>
              <strong>Beam test mode:</strong>{" "}
              you&apos;ll see Beam&apos;s real playground checkout. Use Beam test cards only - no real
              money moves.
            </p>
          </div>
        ) : null}

        {/* While the checkout runs the button stays focusable (aria-disabled + early return), so keyboard
            focus isn't dropped to <body>; BookingApp announces "Taking you to Beam". `disabled` only when locked. */}
        <button
          type="button"
          onClick={() => {
            if (!submitting) onPay();
          }}
          disabled={locked}
          aria-disabled={submitting || undefined}
          aria-busy={submitting || undefined}
          className="inline-flex min-h-13 w-full items-center justify-center gap-2 rounded-(--bk-radius-pill) bg-(--bk-accent) px-6 py-3 text-base font-semibold text-(--bk-accent-contrast) transition-colors hover:bg-(--bk-accent-hover) disabled:cursor-not-allowed disabled:opacity-(--bk-disabled-opacity) disabled:hover:bg-(--bk-accent) aria-disabled:cursor-wait aria-disabled:opacity-(--bk-disabled-opacity)"
        >
          {submitting ? (
            <>
              <LoaderCircle size={20} aria-hidden="true" className="shrink-0 animate-spin" />
              Taking you to Beam...
            </>
          ) : (
            <>
              <Lock size={18} aria-hidden="true" className="shrink-0" />
              {/* One line on phones: "Pay THB x" (+ "securely with Beam" under the button); the full label from sm. */}
              <span className="whitespace-nowrap sm:hidden">Pay {dueNow}</span>
              <span className="hidden sm:inline">Pay {dueNow} securely with Beam</span>
              <ArrowRight size={18} aria-hidden="true" className="shrink-0" />
            </>
          )}
        </button>
        <p className="-mt-2 flex items-center justify-center gap-1 text-xs font-medium text-(--bk-text-muted) sm:hidden" aria-hidden="true">
          <Lock size={12} className="shrink-0" />
          Securely with Beam
        </p>
        <p className="flex items-start gap-1.5 text-xs text-(--bk-text-subtle)">
          <ShieldCheck size={14} aria-hidden="true" className="mt-px shrink-0" />
          <span>
            By paying you agree to the booking and cancellation policy. {HOUSE_POLICIES.cancellation} Prices are in Thai baht; your bank may
            convert them.
          </span>
        </p>
      </div>
    </div>
  );
}
