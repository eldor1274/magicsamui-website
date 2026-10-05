"use client";

// OWNER: ui-checkout
// "Learn more" under the summary CTA: how payment works with Beam. Replaces
// Cloudbeds' "Secure Online Payment" modal. Keep SecurePaymentModalProps stable.

import { useRef } from "react";
import { CreditCard, Lock, QrCode, ShieldCheck, Smartphone } from "lucide-react";
import Modal from "../ui/Modal";
import PaymentMethodBadges, { CARD_METHODS } from "./PaymentMethodBadges";

export interface SecurePaymentModalProps {
  open: boolean;
  onClose: () => void;
}

const POINTS = [
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

export default function SecurePaymentModal({ open, onClose }: SecurePaymentModalProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Secure payment by Beam"
      size="md"
      initialFocusRef={closeRef}
      footer={
        <div className="flex justify-end">
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="rounded-(--bk-radius-pill) bg-(--bk-accent) px-6 py-2.5 text-sm font-medium text-(--bk-accent-contrast) transition-colors hover:bg-(--bk-accent-hover)"
          >
            Got it
          </button>
        </div>
      }
    >
      <div className="space-y-5 text-sm text-(--bk-text-muted)">
        <div className="flex items-start gap-3 rounded-(--bk-radius-control) bg-(--bk-accent-soft) p-3 text-(--bk-accent-soft-text)">
          <ShieldCheck size={22} aria-hidden="true" className="mt-0.5 shrink-0" />
          <p>
            Payments are processed by <strong>Beam</strong> (beamcheckout.com), a Thai payment gateway. You pay on Beam&apos;s secure hosted
            page and come straight back here with your booking reference.
          </p>
        </div>
        <ul className="space-y-4">
          {POINTS.map(({ icon: Icon, title, body }) => (
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
          <PaymentMethodBadges methods={[...CARD_METHODS, "PromptPay"]} />
        </div>
        <p className="text-xs text-(--bk-text-subtle)">
          Any card processing fee is shown as its own line in your reservation summary before you pay - no hidden charges.
        </p>
      </div>
    </Modal>
  );
}
