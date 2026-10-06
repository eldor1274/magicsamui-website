// OWNER: ui-checkout
// Payment method badges (plain text, no brand artwork) and the WhatsApp
// help link shared by the payment step, the secure-payment modal, the
// simulated Beam page and the return page. Which badges a provider shows
// comes from paymentMethodLabels(config) (Stripe Thailand: Visa, Mastercard,
// PromptPay, Apple Pay, Google Pay; Beam: all five card brands + PromptPay).

import { site } from "@/data/site";
import type { PaymentMethodLabel } from "@/lib/booking/paymentCopy";

export type PaymentMethodName = PaymentMethodLabel;

export const CARD_METHODS: PaymentMethodName[] = ["Visa", "Mastercard", "JCB", "Amex", "UnionPay"];
export const ALL_METHODS: PaymentMethodName[] = [...CARD_METHODS, "PromptPay"];

export interface PaymentMethodBadgesProps {
  methods?: PaymentMethodName[];
  /** Highlights one badge (e.g. the detected card brand). */
  highlight?: string | null;
  size?: "sm" | "md";
  className?: string;
  label?: string;
}

export default function PaymentMethodBadges({
  methods = ALL_METHODS,
  highlight = null,
  size = "md",
  className = "",
  label = "Accepted payment methods",
}: PaymentMethodBadgesProps) {
  const pad = size === "sm" ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-xs";
  return (
    <ul aria-label={label} className={`flex flex-wrap gap-1.5 ${className}`}>
      {methods.map((m) => {
        const on = highlight === m;
        return (
          <li
            key={m}
            className={`rounded-md border font-semibold tracking-wide transition-colors ${pad} ${
              on
                ? "border-(--bk-accent) bg-(--bk-accent-soft) text-(--bk-accent-soft-text)"
                : highlight
                  ? "border-(--bk-border) bg-(--bk-surface) text-(--bk-text-subtle)"
                  : "border-(--bk-border-strong) bg-(--bk-surface) text-(--bk-text)"
            }`}
          >
            {m}
          </li>
        );
      })}
    </ul>
  );
}

/** wa.me link with a prefilled message (never include personal data in it). */
export function whatsappHref(message: string): string {
  return `${site.whatsapp}?text=${encodeURIComponent(message)}`;
}
