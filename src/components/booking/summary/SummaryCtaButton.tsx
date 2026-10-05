"use client";

// OWNER: ui-search-results
// The summary's primary pill (Book Now / Continue / Pay). On the guest step it
// is a submit button for the guest <form> (form attribute), elsewhere a plain
// button. While busy it shows a spinner and ignores clicks.

import { Loader2 } from "lucide-react";
import { BTN_PRIMARY } from "../ui/styles";
import type { SummaryCta } from "./ReservationSummary";

export default function SummaryCtaButton({
  cta,
  className = "",
  ariaLabel,
}: {
  cta: SummaryCta;
  className?: string;
  /** Fuller accessible name when the visible label is shortened (must contain the visible text). */
  ariaLabel?: string;
}) {
  // Busy keeps the button focusable (aria-disabled + early return) so keyboard focus isn't dropped;
  // only a real "can't do this" state uses the disabled attribute.
  const busy = Boolean(cta.busy);
  return (
    <button
      // A fresh element when the mode flips: the add-ons "Continue" click re-renders this as the guest
      // form's submit button mid-click, and the browser would then also submit the (empty) guest form.
      key={cta.submitForm ? `submit:${cta.submitForm}` : "action"}
      type={cta.submitForm ? "submit" : "button"}
      form={cta.submitForm}
      onClick={
        cta.submitForm
          ? (e) => {
              if (busy) e.preventDefault();
            }
          : () => {
              if (!busy) cta.onClick?.();
            }
      }
      disabled={Boolean(cta.disabled)}
      aria-disabled={busy || undefined}
      aria-busy={busy || undefined}
      aria-label={ariaLabel}
      data-summary-cta=""
      className={`${BTN_PRIMARY} ${className}`}
    >
      {cta.busy && <Loader2 size={18} className="animate-spin" aria-hidden="true" />}
      <span>{cta.label}</span>
    </button>
  );
}
