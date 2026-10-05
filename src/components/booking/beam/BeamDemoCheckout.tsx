"use client";

// OWNER: ui-checkout
// SIMULATED Beam hosted checkout (demo mode only; the page 404s otherwise).
// It looks and behaves like Beam's payment-link page so the owner can see
// the whole journey, but nothing here is a real payment.
//
// HARD RULES (do not relax):
// - Card number, expiry, CVV and name live only in this component's React
//   state. They are never sent over the network, never put in storage, and
//   the inputs have no `name` so even a native form submit carries nothing.
// - Only Beam playground test card numbers are accepted (classifyDemoCard);
//   anything else shows DEMO_CARD_HINT.
// - The only request is postDemoPay({ t: token, outcome }).
// Keep BeamDemoCheckoutProps stable.

import { useId, useMemo, useState, useSyncExternalStore } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { CircleAlert, Clock, CreditCard, FlaskConical, LoaderCircle, Lock, QrCode, ShieldCheck, X } from "lucide-react";
import { postDemoPay } from "@/lib/booking/apiClient";
import {
  DEMO_CARD_HINT,
  DEMO_FAILURE_MESSAGES,
  DEMO_TEST_CARDS,
  classifyDemoCard,
  detectBrand,
  digitsOnly,
  formatCardNumber,
  isValidCvv,
  isValidExpiry,
} from "@/lib/booking/demoCards";
import { formatThbWithCode } from "@/lib/booking/format";
import type { DemoPayOutcome } from "@/lib/booking/types";
import FieldShell, { FIELD_CONTROL_CLASS, describedBy } from "../checkout/FormField";
import PaymentMethodBadges, { CARD_METHODS } from "../checkout/PaymentMethodBadges";

export interface BeamDemoCheckoutProps {
  /** Signed booking token (pass straight to postDemoPay). */
  token: string;
  bookingRef: string;
  merchantName: string;
  amountSatang: number;
  /** One-line order description (rooms, dates). */
  description: string;
  /** ISO timestamp when this simulated link expires (30 min). */
  expiresAt: string;
  /** Where Cancel goes (the booking page with the cart intact). */
  cancelUrl: string;
}

type Method = "card" | "promptpay";
type CardField = "number" | "expiry" | "cvv" | "name";

/* ------------------------------ clock ------------------------------ */

function subscribeSeconds(onChange: () => void): () => void {
  const timer = window.setInterval(onChange, 1000);
  return () => window.clearInterval(timer);
}
const nowSeconds = () => Math.floor(Date.now() / 1000);
const noClock = () => null;

/** Seconds since epoch, ticking once a second; null on the server. */
function useNowSeconds(): number | null {
  return useSyncExternalStore(subscribeSeconds, nowSeconds, noClock);
}

function formatCountdown(totalSeconds: number): string {
  const s = Math.max(0, totalSeconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/* --------------------------- placeholder QR -------------------------- */

const QR_SIZE = 25;

function hashString(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function inFinder(x: number, y: number): boolean {
  const corners: [number, number][] = [
    [0, 0],
    [QR_SIZE - 7, 0],
    [0, QR_SIZE - 7],
  ];
  return corners.some(([cx, cy]) => x >= cx - 1 && x <= cx + 7 && y >= cy - 1 && y <= cy + 7);
}

/** Decorative QR-like pattern seeded by the booking ref. It encodes nothing and cannot be scanned. */
function PlaceholderQr({ seed }: { seed: string }) {
  const cells = useMemo(() => {
    let state = hashString(seed) || 1;
    const out: [number, number][] = [];
    for (let y = 0; y < QR_SIZE; y++) {
      for (let x = 0; x < QR_SIZE; x++) {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        if (!inFinder(x, y) && (state >>> 0) % 100 < 46) out.push([x, y]);
      }
    }
    return out;
  }, [seed]);

  const finder = (cx: number, cy: number) => (
    <g key={`${cx}-${cy}`}>
      <rect x={cx} y={cy} width={7} height={7} fill="currentColor" />
      <rect x={cx + 1} y={cy + 1} width={5} height={5} fill="var(--bk-surface)" />
      <rect x={cx + 2} y={cy + 2} width={3} height={3} fill="currentColor" />
    </g>
  );

  return (
    <svg
      viewBox={`-2 -2 ${QR_SIZE + 4} ${QR_SIZE + 4}`}
      className="h-full w-full text-(--bk-text)"
      role="img"
      aria-label="Placeholder PromptPay QR code (not scannable)"
    >
      <rect x={-2} y={-2} width={QR_SIZE + 4} height={QR_SIZE + 4} fill="var(--bk-surface)" />
      {cells.map(([x, y]) => (
        <rect key={`${x}-${y}`} x={x} y={y} width={1.02} height={1.02} fill="currentColor" />
      ))}
      {finder(0, 0)}
      {finder(QR_SIZE - 7, 0)}
      {finder(0, QR_SIZE - 7)}
    </svg>
  );
}

/* ----------------------------- component ----------------------------- */

const OUTCOME_FOR_FAILURE: Record<string, Exclude<DemoPayOutcome, "paid">> = {
  CH_CARD_DECLINED: "declined",
  CH_INSUFFICIENT_FUNDS: "insufficient_funds",
};

function isSameOriginUrl(url: string): boolean {
  try {
    return new URL(url, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

function formatExpiryInput(value: string, previous: string): string {
  const digits = digitsOnly(value).slice(0, 4);
  // Let backspace remove the slash naturally.
  if (value.length < previous.length && previous.endsWith("/") && digits.length <= 2) return digits.slice(0, 1);
  if (digits.length >= 3) return `${digits.slice(0, 2)}/${digits.slice(2)}`;
  if (digits.length === 2) return `${digits}/`;
  return digits;
}

export default function BeamDemoCheckout({
  token,
  bookingRef,
  merchantName,
  amountSatang,
  description,
  expiresAt,
  cancelUrl,
}: BeamDemoCheckoutProps) {
  const uid = useId();
  const now = useNowSeconds();
  const [method, setMethod] = useState<Method>("card");
  const [card, setCard] = useState<Record<CardField, string>>({ number: "", expiry: "", cvv: "", name: "" });
  const [errors, setErrors] = useState<Partial<Record<CardField, string>>>({});
  const [busy, setBusy] = useState<false | "paying" | "redirecting">(false);
  const [failure, setFailure] = useState<string | null>(null);

  const expiresAtSeconds = Math.floor(Date.parse(expiresAt) / 1000);
  const remaining = now === null || Number.isNaN(expiresAtSeconds) ? null : expiresAtSeconds - now;
  const expired = remaining !== null && remaining <= 0;
  const brand = detectBrand(card.number);
  const amount = formatThbWithCode(amountSatang);
  const disabled = busy !== false || expired || now === null;

  const ids = {
    number: `${uid}-number`,
    expiry: `${uid}-expiry`,
    cvv: `${uid}-cvv`,
    name: `${uid}-name`,
    tabCard: `${uid}-tab-card`,
    tabQr: `${uid}-tab-qr`,
    panel: `${uid}-panel`,
  };

  function update(field: CardField, value: string) {
    setCard((c) => ({ ...c, [field]: value }));
    if (errors[field]) setErrors((e) => ({ ...e, [field]: undefined }));
    if (failure) setFailure(null);
  }

  function fillTestCard(number: string) {
    const d = new Date();
    const yy = String((d.getFullYear() + 3) % 100).padStart(2, "0");
    setCard((c) => ({
      number: formatCardNumber(number),
      expiry: `12/${yy}`,
      cvv: detectBrand(number) === "Amex" ? "1234" : "123",
      name: c.name || "Demo Guest",
    }));
    setErrors({});
    setFailure(null);
    setMethod("card");
  }

  async function pay(outcome: DemoPayOutcome) {
    setBusy("paying");
    setFailure(null);
    // Outcome only - the card fields are deliberately not part of this call.
    const res = await postDemoPay({ t: token, outcome });
    if (res.ok && res.status === "paid") {
      if (!isSameOriginUrl(res.returnUrl)) {
        setBusy(false);
        setFailure("Unexpected return address. Nothing was charged.");
        return;
      }
      setBusy("redirecting");
      // replace(): like a gateway's server redirect, Back from the return page must not land on a paid checkout.
      window.location.replace(res.returnUrl);
      return;
    }
    setBusy(false);
    setCard((c) => ({ ...c, cvv: "" }));
    if (res.ok) {
      const key = OUTCOME_FOR_FAILURE[res.failureCode] ?? "declined";
      setFailure(DEMO_FAILURE_MESSAGES[key]);
    } else {
      setFailure(res.message);
    }
  }

  function onCardSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (disabled) return;
    const next: Partial<Record<CardField, string>> = {};
    const check = classifyDemoCard(card.number);
    if (!digitsOnly(card.number)) next.number = "Please enter the card number.";
    else if (!check.ok) next.number = check.message;
    if (!isValidExpiry(card.expiry)) next.expiry = "Enter a future expiry date as MM/YY.";
    if (!isValidCvv(card.cvv, brand)) next.cvv = brand === "Amex" ? "Enter the 4-digit security code." : "Enter the 3-digit security code.";
    if (!card.name.trim()) next.name = "Enter the name on the card.";
    setErrors(next);
    const first = (["number", "expiry", "cvv", "name"] as CardField[]).find((f) => next[f]);
    if (first) {
      document.getElementById(ids[first])?.focus();
      return;
    }
    if (check.ok) void pay(check.outcome);
  }

  function onTabKey(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft" && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const next: Method = e.key === "Home" ? "card" : e.key === "End" ? "promptpay" : method === "card" ? "promptpay" : "card";
    setMethod(next);
    document.getElementById(next === "card" ? ids.tabCard : ids.tabQr)?.focus();
  }

  const tabClass = (on: boolean) =>
    `flex flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-(--bk-radius-control) px-2 py-2.5 text-sm font-semibold transition-colors ${
      on ? "bg-(--bk-surface) text-(--bk-text) shadow-(--bk-shadow-card)" : "text-(--bk-text-muted) hover:text-(--bk-text)"
    }`;

  return (
    <div className="mx-auto w-full max-w-md space-y-4">
      <div
        role="note"
        className="flex items-center justify-center gap-2 rounded-(--bk-radius-control) bg-(--bk-danger) px-4 py-3 text-center text-sm font-bold uppercase tracking-wide text-(--bk-surface)"
      >
        <FlaskConical size={18} aria-hidden="true" className="shrink-0" />
        Simulated Beam checkout - no real payment
      </div>

      <div className="overflow-hidden rounded-(--bk-radius-card) bg-(--bk-surface) shadow-(--bk-shadow-pop)">
        {/* Beam-style header */}
        <div className="flex items-center justify-between gap-3 border-b border-(--bk-border) px-5 py-3">
          <p className="text-lg font-extrabold lowercase tracking-tight text-(--bk-text)" aria-label="Beam checkout (simulated)">
            beam<span className="font-medium text-(--bk-text-subtle)"> checkout</span>
          </p>
          <span className="rounded-(--bk-radius-pill) bg-(--bk-warning-soft) px-2.5 py-1 text-xs font-semibold text-(--bk-warning)">
            Demo
          </span>
        </div>

        {/* Order */}
        <div className="space-y-1 bg-(--bk-surface-muted) px-5 py-4">
          <p className="text-sm font-medium text-(--bk-text-muted)">{merchantName}</p>
          <p className="bk-price text-3xl font-semibold text-(--bk-text)">{amount}</p>
          <p className="text-sm text-(--bk-text-muted)">{description}</p>
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-xs text-(--bk-text-subtle)">
            <span>Reference {bookingRef}</span>
            <span className="inline-flex min-w-[9.5rem] items-center justify-end gap-1 tabular-nums" aria-live="off">
              <Clock size={12} aria-hidden="true" />
              {remaining === null ? "Link valid for 30 min" : expired ? "Link expired" : `Link expires in ${formatCountdown(remaining)}`}
            </span>
          </div>
        </div>

        <div className="space-y-4 px-5 py-5">
          {expired ? (
            <div role="alert" className="space-y-3 text-center">
              <p className="font-semibold text-(--bk-text)">This payment link has expired</p>
              <p className="text-sm text-(--bk-text-muted)">
                Nothing has been charged. Go back to your booking to start the payment again.
              </p>
              <a
                href={cancelUrl}
                className="inline-flex min-h-11 items-center justify-center rounded-(--bk-radius-pill) bg-(--bk-accent) px-6 text-sm font-semibold text-(--bk-accent-contrast) hover:bg-(--bk-accent-hover)"
              >
                Back to your booking
              </a>
            </div>
          ) : (
            <>
              <div
                role="tablist"
                aria-label="Payment method"
                className="flex gap-1 rounded-(--bk-radius-control) bg-(--bk-surface-sunken) p-1"
              >
                <button
                  id={ids.tabCard}
                  type="button"
                  role="tab"
                  aria-selected={method === "card"}
                  aria-controls={ids.panel}
                  tabIndex={method === "card" ? 0 : -1}
                  onClick={() => setMethod("card")}
                  onKeyDown={onTabKey}
                  className={tabClass(method === "card")}
                >
                  <CreditCard size={16} aria-hidden="true" />
                  Card
                </button>
                <button
                  id={ids.tabQr}
                  type="button"
                  role="tab"
                  aria-selected={method === "promptpay"}
                  aria-controls={ids.panel}
                  tabIndex={method === "promptpay" ? 0 : -1}
                  onClick={() => setMethod("promptpay")}
                  onKeyDown={onTabKey}
                  className={tabClass(method === "promptpay")}
                >
                  <QrCode size={16} aria-hidden="true" />
                  PromptPay QR
                </button>
              </div>

              {failure && (
                <div
                  role="alert"
                  className="flex items-start gap-2 rounded-(--bk-radius-control) border border-(--bk-danger) bg-(--bk-danger-soft) p-3 text-sm text-(--bk-text)"
                >
                  <CircleAlert size={18} aria-hidden="true" className="mt-0.5 shrink-0 text-(--bk-danger)" />
                  <p>{failure}</p>
                </div>
              )}

              <div id={ids.panel} role="tabpanel" aria-labelledby={method === "card" ? ids.tabCard : ids.tabQr}>
                {method === "card" ? (
                  // No `name` on any input and no action: a native submit would carry no card data.
                  <form noValidate onSubmit={onCardSubmit} autoComplete="off" className="space-y-3">
                    <PaymentMethodBadges
                      methods={CARD_METHODS}
                      highlight={brand === "Unknown" ? null : brand}
                      size="sm"
                      label="Accepted cards"
                    />
                    <FieldShell id={ids.number} label="Card number" required error={errors.number ?? null}>
                      <input
                        id={ids.number}
                        type="text"
                        inputMode="numeric"
                        autoComplete="off"
                        autoCorrect="off"
                        spellCheck={false}
                        placeholder="4111 1111 1111 1111"
                        maxLength={23}
                        value={card.number}
                        onChange={(e) => update("number", formatCardNumber(e.target.value))}
                        disabled={disabled}
                        aria-required="true"
                        aria-invalid={Boolean(errors.number) || undefined}
                        aria-describedby={describedBy(ids.number, { error: Boolean(errors.number) })}
                        className={`${FIELD_CONTROL_CLASS} tabular-nums tracking-wide`}
                      />
                    </FieldShell>
                    <div className="grid grid-cols-2 gap-3">
                      <FieldShell id={ids.expiry} label="Expiry (MM/YY)" required error={errors.expiry ?? null}>
                        <input
                          id={ids.expiry}
                          type="text"
                          inputMode="numeric"
                          autoComplete="off"
                          placeholder="12/29"
                          maxLength={5}
                          value={card.expiry}
                          onChange={(e) => update("expiry", formatExpiryInput(e.target.value, card.expiry))}
                          disabled={disabled}
                          aria-required="true"
                          aria-invalid={Boolean(errors.expiry) || undefined}
                          aria-describedby={describedBy(ids.expiry, { error: Boolean(errors.expiry) })}
                          className={`${FIELD_CONTROL_CLASS} tabular-nums`}
                        />
                      </FieldShell>
                      <FieldShell id={ids.cvv} label="Security code" required error={errors.cvv ?? null}>
                        <input
                          id={ids.cvv}
                          type="password"
                          inputMode="numeric"
                          autoComplete="off"
                          placeholder={brand === "Amex" ? "1234" : "123"}
                          maxLength={4}
                          value={card.cvv}
                          onChange={(e) => update("cvv", digitsOnly(e.target.value).slice(0, 4))}
                          disabled={disabled}
                          aria-required="true"
                          aria-invalid={Boolean(errors.cvv) || undefined}
                          aria-describedby={describedBy(ids.cvv, { error: Boolean(errors.cvv) })}
                          className={`${FIELD_CONTROL_CLASS} tabular-nums`}
                        />
                      </FieldShell>
                    </div>
                    <FieldShell id={ids.name} label="Name on card" required error={errors.name ?? null}>
                      <input
                        id={ids.name}
                        type="text"
                        autoComplete="off"
                        autoCapitalize="characters"
                        spellCheck={false}
                        maxLength={60}
                        value={card.name}
                        onChange={(e) => update("name", e.target.value)}
                        disabled={disabled}
                        aria-required="true"
                        aria-invalid={Boolean(errors.name) || undefined}
                        aria-describedby={describedBy(ids.name, { error: Boolean(errors.name) })}
                        className={FIELD_CONTROL_CLASS}
                      />
                    </FieldShell>
                    <button
                      type="submit"
                      disabled={disabled}
                      aria-busy={busy !== false || undefined}
                      className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-(--bk-radius-pill) bg-(--bk-accent) px-6 text-base font-semibold text-(--bk-accent-contrast) transition-colors hover:bg-(--bk-accent-hover) disabled:cursor-not-allowed disabled:opacity-(--bk-disabled-opacity)"
                    >
                      {busy ? (
                        <>
                          <LoaderCircle size={18} aria-hidden="true" className="animate-spin" />
                          {busy === "redirecting" ? "Payment approved - returning..." : "Processing..."}
                        </>
                      ) : (
                        <>
                          <Lock size={16} aria-hidden="true" />
                          Pay {amount}
                        </>
                      )}
                    </button>
                    <p className="text-center text-xs text-(--bk-text-subtle)">{DEMO_CARD_HINT}</p>
                  </form>
                ) : (
                  <div className="space-y-4 text-center">
                    <p className="text-sm text-(--bk-text-muted)">
                      Scan with any Thai banking app to pay{" "}
                      <span className="whitespace-nowrap font-semibold text-(--bk-text)">{amount}</span>.
                    </p>
                    <div className="relative mx-auto aspect-square w-52 rounded-(--bk-radius-control) border border-(--bk-border) bg-(--bk-surface) p-2">
                      <PlaceholderQr seed={bookingRef} />
                      <span className="absolute inset-x-6 top-1/2 -translate-y-1/2 rounded-(--bk-radius-pill) bg-(--bk-danger) px-2 py-1 text-[11px] font-bold uppercase tracking-wide text-(--bk-surface)">
                        Placeholder - not scannable
                      </span>
                    </div>
                    <p className="text-xs text-(--bk-text-subtle)">
                      On the real Beam page this QR is live for the link&apos;s lifetime and the page updates by itself once the bank
                      confirms.
                    </p>
                    <button
                      type="button"
                      onClick={() => void pay("paid")}
                      disabled={disabled}
                      aria-busy={busy !== false || undefined}
                      className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-(--bk-radius-pill) bg-(--bk-accent) px-6 text-base font-semibold text-(--bk-accent-contrast) transition-colors hover:bg-(--bk-accent-hover) disabled:cursor-not-allowed disabled:opacity-(--bk-disabled-opacity)"
                    >
                      {busy ? (
                        <LoaderCircle size={18} aria-hidden="true" className="animate-spin" />
                      ) : (
                        <QrCode size={18} aria-hidden="true" />
                      )}
                      {busy === "redirecting" ? "Payment received - returning..." : busy ? "Confirming..." : "Simulate PromptPay paid"}
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-(--bk-border) px-5 py-3">
          <a
            href={cancelUrl}
            aria-disabled={busy !== false || undefined}
            className={`inline-flex items-center gap-1.5 text-sm font-medium text-(--bk-text-muted) underline-offset-2 hover:text-(--bk-text) hover:underline ${
              busy ? "pointer-events-none opacity-(--bk-disabled-opacity)" : ""
            }`}
          >
            <X size={14} aria-hidden="true" />
            Cancel and return to {merchantName}
          </a>
          <span className="inline-flex items-center gap-1 text-xs text-(--bk-text-subtle)">
            <ShieldCheck size={13} aria-hidden="true" />
            Secured by Beam (simulated)
          </span>
        </div>
      </div>

      {!expired && (
        <details className="rounded-(--bk-radius-card) border border-(--bk-border) bg-(--bk-surface) px-5 py-3 text-sm">
          <summary className="cursor-pointer font-semibold text-(--bk-text)">Beam test cards for this demo</summary>
          <p className="mt-2 text-xs text-(--bk-text-muted)">
            These are Beam&apos;s published playground numbers. Any future expiry works; the security code is 123 (Amex 1234). Real card
            numbers are refused here and nothing you type leaves this page.
          </p>
          <ul className="mt-3 divide-y divide-(--bk-border)">
            {DEMO_TEST_CARDS.map((c) => (
              <li key={c.number} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="font-mono text-xs text-(--bk-text) tabular-nums">{formatCardNumber(c.number)}</p>
                  <p className="text-xs text-(--bk-text-muted)">{c.label}</p>
                </div>
                <button
                  type="button"
                  onClick={() => fillTestCard(c.number)}
                  disabled={disabled}
                  className="shrink-0 rounded-(--bk-radius-pill) border border-(--bk-accent) px-3 py-1 text-xs font-semibold text-(--bk-text) transition-colors hover:bg-(--bk-accent) hover:text-(--bk-accent-contrast) disabled:opacity-(--bk-disabled-opacity)"
                >
                  Use
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
