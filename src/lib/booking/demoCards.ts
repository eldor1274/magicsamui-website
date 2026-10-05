// Beam playground test cards for the SIMULATED checkout page. Runs in the
// browser only; the card number is classified locally and never sent or
// stored anywhere - only the resulting outcome is posted to demo-pay.

import type { DemoPayOutcome } from "./types.ts";

export type CardBrand = "Visa" | "Mastercard" | "JCB" | "Amex" | "UnionPay" | "Unknown";

export interface DemoTestCard {
  number: string;
  brand: CardBrand;
  outcome: DemoPayOutcome;
  label: string;
}

/** From Beam's playground test data (docs.beamcheckout.com). */
export const DEMO_TEST_CARDS: DemoTestCard[] = [
  { number: "4111111111111111", brand: "Visa", outcome: "paid", label: "Visa - succeeds" },
  { number: "5372074248113841", brand: "Mastercard", outcome: "paid", label: "Mastercard - succeeds" },
  { number: "378282246310005", brand: "Amex", outcome: "paid", label: "Amex - succeeds (CVV 4 digits)" },
  { number: "4111111111000025", brand: "Visa", outcome: "declined", label: "Visa - card declined" },
  { number: "4943129900084541", brand: "Visa", outcome: "insufficient_funds", label: "Visa - insufficient funds" },
];

export const DEMO_CARD_HINT = "Demo only: use a Beam test card such as 4111 1111 1111 1111";

export const DEMO_FAILURE_MESSAGES: Record<Exclude<DemoPayOutcome, "paid">, string> = {
  declined: "Your card was declined. Please try another card or pay with PromptPay.",
  insufficient_funds: "Insufficient funds. Please try another card or pay with PromptPay.",
};

export function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

export function detectBrand(cardNumber: string): CardBrand {
  const n = digitsOnly(cardNumber);
  if (/^3[47]/.test(n)) return "Amex";
  if (/^4/.test(n)) return "Visa";
  if (/^(5[1-5]|2[2-7])/.test(n)) return "Mastercard";
  if (/^35/.test(n)) return "JCB";
  if (/^62/.test(n)) return "UnionPay";
  return "Unknown";
}

/** "4111111111111111" -> "4111 1111 1111 1111" (Amex 4-6-5). */
export function formatCardNumber(value: string): string {
  const n = digitsOnly(value).slice(0, 19);
  if (detectBrand(n) === "Amex") {
    return [n.slice(0, 4), n.slice(4, 10), n.slice(10, 15)].filter(Boolean).join(" ");
  }
  return n.replace(/(\d{4})(?=\d)/g, "$1 ");
}

export type DemoCardCheck =
  | { ok: true; outcome: DemoPayOutcome; brand: CardBrand }
  | { ok: false; message: string };

/** Classifies a typed card number against the Beam test cards. */
export function classifyDemoCard(cardNumber: string): DemoCardCheck {
  const n = digitsOnly(cardNumber);
  const card = DEMO_TEST_CARDS.find((c) => c.number === n);
  if (!card) return { ok: false, message: DEMO_CARD_HINT };
  return { ok: true, outcome: card.outcome, brand: card.brand };
}

/** MM/YY in the future (month granularity). */
export function isValidExpiry(value: string, now: Date = new Date()): boolean {
  const m = /^(\d{2})\s*\/\s*(\d{2})$/.exec(value.trim());
  if (!m) return false;
  const month = Number(m[1]);
  const year = 2000 + Number(m[2]);
  if (month < 1 || month > 12) return false;
  const nowYear = now.getUTCFullYear();
  const nowMonth = now.getUTCMonth() + 1;
  return year > nowYear || (year === nowYear && month >= nowMonth);
}

export function isValidCvv(value: string, brand: CardBrand): boolean {
  return brand === "Amex" ? /^\d{4}$/.test(value) : /^\d{3}$/.test(value);
}
