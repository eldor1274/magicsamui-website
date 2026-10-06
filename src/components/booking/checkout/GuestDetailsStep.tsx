"use client";

// OWNER: ui-checkout
// "Add Guests" step: the lead guest's details, arrival time, special
// requests, the policy summary and the required policy checkbox. Inline
// errors (aria-invalid + aria-describedby) appear after the first submit and
// focus moves to the first invalid field. The <form id={formId}> is also
// submitted by the summary CTA / mobile bar (form="guest-form").
// Guest details are personal data. Demo/Beam modes keep them in the browser;
// Stripe modes (config.requiresGuestDetails) send them in the checkout request
// body only - to Cloudbeds for the reservation and to Stripe for the receipt -
// never in a URL, token, log or analytics payload. Stripe modes also ask for
// an optional postcode (Cloudbeds guestZip; the server re-validates it).
// Keep GuestDetailsStepProps stable.

import { useContext } from "react";
import type { FormEvent } from "react";
import { ArrowRight, Clock, Lock, Plane, ShieldCheck, Users } from "lucide-react";
import { HOUSE_POLICIES } from "@/lib/booking/catalogue";
import { ARRIVAL_TIME_OPTIONS, GUEST_LIMITS, validateGuest } from "@/lib/booking/guest";
import type { GuestDetails, GuestErrors, GuestField } from "@/lib/booking/guest";
import CountrySelect from "./CountrySelect";
import FieldShell, { FIELD_CONTROL_CLASS, describedBy } from "./FormField";
import { revealAboveBars } from "../bottomBars";
import { BookingContext } from "../state";
import PhoneInput from "./PhoneInput";
import { getCountry } from "./countries";

export interface GuestDetailsStepProps {
  /** id for the <form>; the summary CTA submits it via form={formId}. */
  formId: string;
  guest: GuestDetails;
  /** validateGuest(guest) - display only when showErrors. */
  errors: GuestErrors;
  /** True after the first submit attempt. */
  showErrors: boolean;
  onChange: (patch: Partial<GuestDetails>) => void;
  /** Call from the form's onSubmit (after preventDefault). BookingApp validates and advances. */
  onSubmit: () => void;
}

/** Order used to find the first invalid field to focus. */
const FOCUS_ORDER: GuestField[] = [
  "firstName",
  "lastName",
  "country",
  "postcode",
  "email",
  "dialCode",
  "phone",
  "arrivalTime",
  "specialRequests",
  "agreedToPolicy",
];

export default function GuestDetailsStep({ formId, guest, errors, showErrors, onChange, onSubmit }: GuestDetailsStepProps) {
  const ids: Record<GuestField, string> = {
    firstName: `${formId}-firstName`,
    lastName: `${formId}-lastName`,
    country: `${formId}-country`,
    email: `${formId}-email`,
    dialCode: `${formId}-phone-dial`,
    phone: `${formId}-phone`,
    postcode: `${formId}-postcode`,
    arrivalTime: `${formId}-arrivalTime`,
    specialRequests: `${formId}-specialRequests`,
    agreedToPolicy: `${formId}-agreedToPolicy`,
  };
  const bookingConfig = useContext(BookingContext)?.config;
  // Only a live booking sends a confirmation; the preview modes say what would happen.
  const live = bookingConfig?.live === true;
  const stripe = bookingConfig?.provider === "stripe";
  const collectPostcode = bookingConfig?.collectPostcode === true;
  const sendsDetails = bookingConfig?.requiresGuestDetails === true;
  // Stripe: Cloudbeds only emails a confirmation when CLOUDBEDS_SEND_STATUS_EMAIL is on; otherwise the receipt is the only email.
  const stripeEmails = bookingConfig?.sendsBookingConfirmationEmail ? "payment receipt and booking confirmation are" : "payment receipt is";
  const confirmationHint = stripe
    ? live
      ? `Your ${stripeEmails} sent here.`
      : `In live mode your ${stripeEmails} sent here.`
    : live
      ? "Your booking confirmation is sent here."
      : "In live mode your booking confirmation is sent here.";
  const err = (field: GuestField): string | null => (showErrors ? (errors[field] ?? null) : null);
  // Code + number share one field and one message.
  const errorCount = showErrors ? Object.keys(errors).filter((k) => !(k === "dialCode" && errors.phone)).length : 0;
  const phoneError =
    err("dialCode") && err("phone") && !guest.phone.trim()
      ? "Please choose a country code and enter your phone number."
      : (err("phone") ?? err("dialCode"));
  const requestsLeft = GUEST_LIMITS.specialRequests - guest.specialRequests.length;

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const current = validateGuest(guest);
    onSubmit();
    const first = FOCUS_ORDER.find((f) => current[f]);
    if (first) {
      // Wait a frame so the error text exists before the field is announced.
      requestAnimationFrame(() => {
        const el = document.getElementById(ids[first]);
        el?.focus();
        revealAboveBars(el);
      });
    }
  }

  function onCountry(code: string) {
    const patch: Partial<GuestDetails> = { country: code };
    const previousDial = getCountry(guest.country)?.dial ?? "";
    const nextDial = getCountry(code)?.dial;
    // Follow the country with the phone code unless the guest chose a different one.
    if (nextDial && (guest.dialCode === "" || guest.dialCode === previousDial)) patch.dialCode = nextDial;
    onChange(patch);
  }

  return (
    // data-clarity-mask: names, email, phone and free-text requests are personal data; never rely on the
    // Clarity dashboard's masking mode for them.
    <form
      id={formId}
      noValidate
      data-clarity-mask="true"
      onSubmit={handleSubmit}
      aria-describedby={`${formId}-required-note`}
      className="space-y-6 rounded-(--bk-radius-card) bg-(--bk-surface) p-4 shadow-(--bk-shadow-card) sm:p-6"
    >
      <div>
        <p className="text-sm text-(--bk-text-muted)">
          Add the lead guest for this reservation. We&apos;ll use these details for your confirmation.
        </p>
        <p id={`${formId}-required-note`} className="mt-1 text-xs text-(--bk-text-subtle)">
          Fields marked with * are required.
        </p>
      </div>

      <div aria-live="polite">
        {errorCount > 0 && (
          <p className="rounded-(--bk-radius-control) border border-(--bk-danger) bg-(--bk-danger-soft) px-4 py-3 text-sm text-(--bk-danger)">
            Please check the {errorCount === 1 ? "highlighted field" : `${errorCount} highlighted fields`} below.
          </p>
        )}
      </div>

      <fieldset className="space-y-3">
        <legend className="bk-heading mb-3 flex items-center gap-2 text-lg text-(--bk-text)">
          <Users size={18} aria-hidden="true" className="text-(--bk-accent)" />
          Lead guest
        </legend>

        <div className="grid gap-3 sm:grid-cols-2">
          <FieldShell id={ids.firstName} label="First Name" required error={err("firstName")}>
            <input
              id={ids.firstName}
              name="firstName"
              type="text"
              autoComplete="given-name"
              autoCapitalize="words"
              maxLength={GUEST_LIMITS.name}
              value={guest.firstName}
              onChange={(e) => onChange({ firstName: e.target.value })}
              required
              aria-required="true"
              aria-invalid={Boolean(err("firstName")) || undefined}
              aria-describedby={describedBy(ids.firstName, { error: Boolean(err("firstName")) })}
              className={FIELD_CONTROL_CLASS}
            />
          </FieldShell>
          <FieldShell id={ids.lastName} label="Last Name" required error={err("lastName")}>
            <input
              id={ids.lastName}
              name="lastName"
              type="text"
              autoComplete="family-name"
              autoCapitalize="words"
              maxLength={GUEST_LIMITS.name}
              value={guest.lastName}
              onChange={(e) => onChange({ lastName: e.target.value })}
              required
              aria-required="true"
              aria-invalid={Boolean(err("lastName")) || undefined}
              aria-describedby={describedBy(ids.lastName, { error: Boolean(err("lastName")) })}
              className={FIELD_CONTROL_CLASS}
            />
          </FieldShell>
        </div>

        <FieldShell id={ids.country} label="Country" required error={err("country")}>
          <CountrySelect
            id={ids.country}
            name="country"
            value={guest.country}
            onChange={onCountry}
            required
            invalid={Boolean(err("country"))}
            describedBy={describedBy(ids.country, { error: Boolean(err("country")) })}
          />
        </FieldShell>

        {collectPostcode && (
          <FieldShell
            id={ids.postcode}
            label="Postcode / ZIP"
            boxClassName="sm:max-w-56"
            error={err("postcode")}
            hint="Optional - leave it empty if your country doesn't use postcodes."
          >
            <input
              id={ids.postcode}
              name="postcode"
              type="text"
              autoComplete="postal-code"
              autoCapitalize="characters"
              spellCheck={false}
              maxLength={GUEST_LIMITS.postcode}
              value={guest.postcode ?? ""}
              onChange={(e) => onChange({ postcode: e.target.value })}
              aria-invalid={Boolean(err("postcode")) || undefined}
              aria-describedby={describedBy(ids.postcode, { error: Boolean(err("postcode")), hint: !err("postcode") })}
              className={FIELD_CONTROL_CLASS}
            />
          </FieldShell>
        )}

        <FieldShell id={ids.email} label="Email" required error={err("email")} hint={confirmationHint}>
          <input
            id={ids.email}
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={GUEST_LIMITS.email}
            value={guest.email}
            onChange={(e) => onChange({ email: e.target.value })}
            required
            aria-required="true"
            aria-invalid={Boolean(err("email")) || undefined}
            aria-describedby={describedBy(ids.email, { error: Boolean(err("email")), hint: !err("email") })}
            className={FIELD_CONTROL_CLASS}
          />
        </FieldShell>

        <FieldShell
          id={ids.phone}
          label="Phone"
          required
          error={phoneError}
          hint="Ideally your WhatsApp number - it's the quickest way for us to reach you."
        >
          <PhoneInput
            id={ids.phone}
            dialCode={guest.dialCode}
            number={guest.phone}
            countryHint={guest.country}
            onChange={({ dialCode, number }) => onChange({ dialCode, phone: number })}
            required
            invalid={Boolean(err("phone"))}
            dialInvalid={Boolean(err("dialCode"))}
            describedBy={describedBy(ids.phone, { error: Boolean(phoneError), hint: !phoneError })}
          />
        </FieldShell>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="bk-heading mb-3 flex items-center gap-2 text-lg text-(--bk-text)">
          <Clock size={18} aria-hidden="true" className="text-(--bk-accent)" />
          Your arrival <span className="font-sans text-sm font-normal text-(--bk-text-subtle)">(optional)</span>
        </legend>

        <FieldShell
          id={ids.arrivalTime}
          label="Estimated arrival time"
          error={err("arrivalTime")}
          hint={`${HOUSE_POLICIES.checkIn}. Arriving late is fine - just let us know.`}
        >
          <select
            id={ids.arrivalTime}
            name="arrivalTime"
            value={guest.arrivalTime}
            onChange={(e) => onChange({ arrivalTime: e.target.value })}
            aria-invalid={Boolean(err("arrivalTime")) || undefined}
            aria-describedby={describedBy(ids.arrivalTime, { error: Boolean(err("arrivalTime")), hint: !err("arrivalTime") })}
            className={`${FIELD_CONTROL_CLASS} cursor-pointer appearance-auto`}
          >
            <option value="">I don&apos;t know yet</option>
            {ARRIVAL_TIME_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </FieldShell>

        <FieldShell
          id={ids.specialRequests}
          label="Special requests"
          error={err("specialRequests")}
          hint={
            <span className="flex justify-between gap-3">
              <span>Celebrations, dietary needs, extra pillows... we&apos;ll do our best.</span>
              <span className="shrink-0 tabular-nums" aria-hidden="true">
                {guest.specialRequests.length}/{GUEST_LIMITS.specialRequests}
              </span>
            </span>
          }
        >
          <textarea
            id={ids.specialRequests}
            name="specialRequests"
            rows={3}
            maxLength={GUEST_LIMITS.specialRequests}
            value={guest.specialRequests}
            onChange={(e) => onChange({ specialRequests: e.target.value })}
            aria-invalid={Boolean(err("specialRequests")) || undefined}
            aria-describedby={describedBy(ids.specialRequests, { error: Boolean(err("specialRequests")), hint: !err("specialRequests") })}
            className={`${FIELD_CONTROL_CLASS} resize-y`}
          />
        </FieldShell>
        {requestsLeft < 100 && (
          <p className="bk-sr-only" aria-live="polite">
            {requestsLeft} characters left
          </p>
        )}
      </fieldset>

      <section
        aria-labelledby={`${formId}-policies`}
        className="space-y-3 rounded-(--bk-radius-control) bg-(--bk-surface-muted) p-4 text-sm"
      >
        <h3 id={`${formId}-policies`} className="bk-heading flex items-center gap-2 text-base text-(--bk-text)">
          <ShieldCheck size={18} aria-hidden="true" className="text-(--bk-accent)" />
          Booking and cancellation policy
        </h3>
        <ul className="space-y-1.5 text-(--bk-text-muted)">
          <li>
            <span className="font-medium text-(--bk-text)">{HOUSE_POLICIES.checkIn}</span>,{" "}
            {HOUSE_POLICIES.checkOut.replace(/^Check-out/, "check-out")}.
          </li>
          <li>
            <span className="font-medium text-(--bk-text)">Cancellation:</span> {HOUSE_POLICIES.cancellation}
          </li>
          <li>{HOUSE_POLICIES.children}</li>
          <li className="flex items-start gap-1.5">
            <Plane size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
            {HOUSE_POLICIES.airportPickup}
          </li>
        </ul>

        <div className="border-t border-(--bk-border) pt-3">
          <label htmlFor={ids.agreedToPolicy} className="flex cursor-pointer items-start gap-3">
            <input
              id={ids.agreedToPolicy}
              name="agreedToPolicy"
              type="checkbox"
              checked={guest.agreedToPolicy}
              onChange={(e) => onChange({ agreedToPolicy: e.target.checked })}
              required
              aria-required="true"
              aria-invalid={Boolean(err("agreedToPolicy")) || undefined}
              aria-describedby={err("agreedToPolicy") ? `${ids.agreedToPolicy}-error` : undefined}
              className="mt-0.5 h-5 w-5 shrink-0 cursor-pointer accent-(--bk-accent)"
            />
            <span className="text-(--bk-text)">
              I agree to the booking and cancellation policy
              <span aria-hidden="true" className="text-(--bk-danger)">
                {" "}
                *
              </span>
            </span>
          </label>
          {err("agreedToPolicy") && (
            <p id={`${ids.agreedToPolicy}-error`} className="mt-1 pl-8 text-sm text-(--bk-danger)">
              {err("agreedToPolicy")}
            </p>
          )}
        </div>
      </section>

      <div className="space-y-3">
        <button
          type="submit"
          className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-(--bk-radius-pill) bg-(--bk-accent) px-6 text-base font-medium text-(--bk-accent-contrast) transition-colors hover:bg-(--bk-accent-hover)"
        >
          Continue to payment
          <ArrowRight size={18} aria-hidden="true" />
        </button>
        <p className="flex items-start justify-center gap-1.5 text-center text-xs text-(--bk-text-subtle)">
          <Lock size={12} aria-hidden="true" className="mt-0.5 shrink-0" />
          {sendsDetails
            ? "When you press Pay, your details go securely to our reservation system to hold your room, and your email to Stripe for your receipt. Nothing is charged until you pay."
            : "Preview: your details stay in this browser and are not sent anywhere. Nothing is booked until you pay."}
        </p>
      </div>
    </form>
  );
}
