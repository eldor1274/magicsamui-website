"use client";

// OWNER: ui-checkout
// "Learn more" under the summary CTA: how payment works with the configured
// provider (Stripe, or Beam / the simulated Beam checkout). Replaces
// Cloudbeds' "Secure Online Payment" modal. Keep SecurePaymentModalProps stable.

import { useContext, useRef } from "react";
import { CreditCard, Lock, QrCode, ShieldCheck, Smartphone, Wallet } from "lucide-react";
import { checkoutBrand, paymentMethodLabels } from "@/lib/booking/paymentCopy";
import type { PublicBookingConfig } from "@/lib/booking/types";
import Modal from "../ui/Modal";
import { BookingContext } from "../state";
import PaymentMethodBadges, { ALL_METHODS } from "./PaymentMethodBadges";

export interface SecurePaymentModalProps {
  open: boolean;
  onClose: () => void;
}

interface Point {
  icon: typeof CreditCard;
  title: string;
  body: string;
}

const BEAM_POINTS: Point[] = [
  {
    icon: CreditCard,
    title: "Cards, including overseas cards",
    body: "Visa, Mastercard, JCB, American Express and UnionPay issued in Thailand or abroad. Your bank may convert the Thai baht amount to your currency.",
  },
  {
    icon: QrCode,
    title: "Thai PromptPay QR",
    body: "Scan the QR code with any Thai banking app and the payment is confirmed in seconds.",
  },
  {
    icon: Lock,
    title: "Card details never touch our site",
    body: "You enter them on Beam's PCI DSS compliant hosted payment page. We never see or store your card number.",
  },
  {
    icon: Smartphone,
    title: "3-D Secure by your bank",
    body: "If your bank asks you to confirm the payment (OTP or app approval), Beam handles it on the same page.",
  },
];

function stripePoints(holdMinutes: number): Point[] {
  return [
    {
      icon: CreditCard,
      title: "Visa and Mastercard, from any country",
      body: "Cards issued in Thailand or abroad. Your bank may convert the Thai baht amount to your currency. American Express, JCB and UnionPay aren't accepted online - message us and we'll help.",
    },
    {
      icon: Wallet,
      title: "Apple Pay and Google Pay",
      body: "Offered on Stripe's page when your device and browser support them.",
    },
    {
      icon: QrCode,
      title: "Thai PromptPay QR",
      body: "Scan the QR code with any Thai banking app and the payment is confirmed in seconds.",
    },
    {
      icon: Lock,
      title: "Card details never touch our site",
      body: "You enter them on Stripe's PCI DSS compliant hosted checkout. We never see or store your card number.",
    },
    {
      icon: Smartphone,
      title: "Your room is held while you pay",
      body: `We reserve your room before you pay and hold it for ${holdMinutes} minutes. If you cancel or the time runs out, nothing is charged and the room is released. 3-D Secure checks by your bank happen on Stripe's page.`,
    },
  ];
}

/** Provider copy for the modal; falls back to Beam's (the demo's) when rendered outside the booking app. */
function modalContent(config: PublicBookingConfig | null) {
  if (config && checkoutBrand(config.provider) === "Stripe") {
    return {
      title: "Secure payment by Stripe",
      intro: (
        <>
          Payments are processed by <strong>Stripe</strong>{" "}(stripe.com), a global payment provider. You pay on Stripe&apos;s secure
          hosted checkout and come straight back here with your booking reference.
        </>
      ),
      points: stripePoints(config.holdMinutes),
      methods: paymentMethodLabels(config),
      feeNote:
        "The payment processing fee is shown as its own line in your reservation summary before you pay - the same for every payment method, no hidden charges.",
    };
  }
  return {
    title: "Secure payment by Beam",
    intro: (
      <>
        Payments are processed by <strong>Beam</strong>{" "}(beamcheckout.com), a Thai payment gateway. You pay on Beam&apos;s secure hosted page
        and come straight back here with your booking reference.
      </>
    ),
    points: BEAM_POINTS,
    methods: config ? paymentMethodLabels(config) : ALL_METHODS,
    feeNote:
      "The payment processing fee (card or PromptPay) is shown as its own line in your reservation summary before you pay - no hidden charges.",
  };
}

export default function SecurePaymentModal({ open, onClose }: SecurePaymentModalProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const config = useContext(BookingContext)?.config ?? null;
  const content = modalContent(config);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={content.title}
      size="md"
      initialFocusRef={closeRef}
      footer={
        <div className="flex justify-end">
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="inline-flex min-h-11 items-center rounded-(--bk-radius-pill) bg-(--bk-accent) px-6 text-sm font-medium text-(--bk-accent-contrast) transition-colors hover:bg-(--bk-accent-hover)"
          >
            Got it
          </button>
        </div>
      }
    >
      <div className="space-y-5 text-sm text-(--bk-text-muted)">
        <div className="flex items-start gap-3 rounded-(--bk-radius-control) bg-(--bk-accent-soft) p-3 text-(--bk-accent-soft-text)">
          <ShieldCheck size={22} aria-hidden="true" className="mt-0.5 shrink-0" />
          <p>{content.intro}</p>
        </div>
        <ul className="space-y-4">
          {content.points.map(({ icon: Icon, title, body }) => (
            <li key={title} className="flex gap-3">
              <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-(--bk-surface-sunken) text-(--bk-text)">
                <Icon size={16} aria-hidden="true" />
              </span>
              <div>
                <p className="font-medium text-(--bk-text)">{title}</p>
                <p className="mt-0.5 leading-relaxed">{body}</p>
              </div>
            </li>
          ))}
        </ul>
        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wider text-(--bk-text-subtle)">Accepted</p>
          <PaymentMethodBadges methods={content.methods} />
        </div>
        <p className="text-xs text-(--bk-text-subtle)">{content.feeNote}</p>
      </div>
    </Modal>
  );
}
