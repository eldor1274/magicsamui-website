// OWNER: ui-checkout
// Breakfast at the villa, on request: the breakfast photo, what it includes, the price per person per day,
// the ordering rule (catalogue BREAKFAST_POLICY) and an "Order breakfast on WhatsApp" button with a
// prefilled message. Paid at the villa or arranged on WhatsApp - nothing here touches the quote or the
// payment. Shown on the booking page while add-ons are off (the live hold-first modes) and on the paid
// return page. Built to be reused when breakfast becomes bookable during checkout: `action` replaces the
// WhatsApp button (e.g. with an Add control) and `note` the payment line. Server-renderable (no state).

import Image from "next/image";
import type { ReactNode } from "react";
import { Coffee, MessageCircle } from "lucide-react";
import { site } from "@/data/site";
import { BREAKFAST_ITEMS, BREAKFAST_PHOTO, BREAKFAST_POLICY, BREAKFAST_SATANG_PER_GUEST_PER_NIGHT } from "@/lib/booking/catalogue";
import { formatStayRange } from "@/lib/booking/dates";
import { formatThbWhole } from "@/lib/booking/format";
import type { IsoDate } from "@/lib/booking/types";
import { whatsappHref } from "../checkout/PaymentMethodBadges";
import { BTN_PRIMARY } from "../ui/styles";

/** "1,000 THB" */
const PRICE = `${formatThbWhole(BREAKFAST_SATANG_PER_GUEST_PER_NIGHT)} THB`;
const PER = "per person per day";
/** "1,000 THB per person per day" */
export const BREAKFAST_PRICE_TEXT = `${PRICE} ${PER}`;

/** The ordering rule: how ordering works and the serving times (the first two BREAKFAST_POLICY sections). */
const ORDERING_RULE = BREAKFAST_POLICY.slice(0, 2);
/** The rest of the policy (being on time, allergies), behind "More about breakfast". */
const MORE_POLICY = BREAKFAST_POLICY.slice(2);

/** The WhatsApp number as written on the site (the phone the wa.me link points at), or null. */
const WHATSAPP_NUMBER = site.phones.find((p) => site.whatsapp.endsWith(p.tel.replace(/^\+/, "")))?.number ?? null;

/** Default payment line (on request: nothing is charged online). */
export const BREAKFAST_PAYMENT_NOTE = `Paid at the villa or arranged with us on WhatsApp${WHATSAPP_NUMBER ? ` (${WHATSAPP_NUMBER})` : ""}.`;

/**
 * The prefilled WhatsApp message: with the stay's dates when known, and the booking reference on the return
 * page. Never personal data (whatsappHref).
 */
export function breakfastWhatsAppMessage({
  checkIn = null,
  checkOut = null,
  ref = null,
}: { checkIn?: IsoDate | null; checkOut?: IsoDate | null; ref?: string | null } = {}): string {
  const what = `breakfast at the villa (${BREAKFAST_PRICE_TEXT})`;
  const stay = checkIn && checkOut ? formatStayRange(checkIn, checkOut, " to ") : null;
  if (ref) return `Hi, I'd like to add ${what} to my booking ${ref}${stay ? ` (${stay})` : ""}. Could you send me the menu?`;
  if (stay) return `Hi, I'm booking a stay for ${stay} and would like ${what}. Could you send me the menu?`;
  return `Hi, I'd like to order ${what}. Could you send me the menu?`;
}

export interface BreakfastCardProps {
  /** The heading. Default "Breakfast at the villa - on request". */
  title?: string;
  /** Small line above the heading (e.g. "Breakfast at the villa - on request" when the title is a call to action). */
  eyebrow?: string;
  /** h3 inside a step (the results list), h2 as a page section (the return page). */
  headingLevel?: 2 | 3;
  /** id for the heading (labels the card). */
  headingId?: string;
  /** The prefilled WhatsApp message (default: breakfastWhatsAppMessage()). */
  whatsappMessage?: string;
  /** Replaces the WhatsApp button (e.g. an Add control once breakfast is bookable during checkout). */
  action?: ReactNode;
  /** Replaces the payment line under the policy. */
  note?: ReactNode;
  className?: string;
}

export default function BreakfastCard({
  title = "Breakfast at the villa - on request",
  eyebrow,
  headingLevel = 3,
  headingId = "breakfast-card-title",
  whatsappMessage,
  action,
  note = BREAKFAST_PAYMENT_NOTE,
  className = "",
}: BreakfastCardProps) {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <article
      aria-labelledby={headingId}
      className={`overflow-hidden rounded-(--bk-radius-card) bg-(--bk-surface) text-(--bk-text) shadow-(--bk-shadow-card)${className ? ` ${className}` : ""}`}
    >
      <div className="grid gap-4 p-3 sm:grid-cols-[minmax(0,44%)_minmax(0,1fr)] sm:p-4">
        <div className="relative aspect-[4/3] overflow-hidden rounded-(--bk-radius-control) bg-(--bk-surface-sunken)">
          <Image
            src={BREAKFAST_PHOTO.src}
            alt={BREAKFAST_PHOTO.alt}
            fill
            sizes="(min-width: 1024px) 300px, (min-width: 640px) 44vw, 100vw"
            className="object-cover"
          />
        </div>

        <div className="flex min-w-0 flex-col">
          {eyebrow && <p className="text-xs font-semibold uppercase tracking-[0.2em] text-(--bk-eyebrow)">{eyebrow}</p>}
          <Heading id={headingId} className={`bk-heading text-lg leading-snug sm:text-xl${eyebrow ? " mt-1" : ""}`}>
            {title}
          </Heading>
          <p className="mt-1">
            <span className="bk-price font-semibold">{PRICE}</span> <span className="text-sm text-(--bk-text-muted)">{PER}</span>
          </p>

          <ul aria-label="What breakfast includes" className="mt-3 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm font-medium">
            {BREAKFAST_ITEMS.map((item, i) => (
              <li key={item} className="inline-flex items-center gap-1.5">
                {i === 0 && <Coffee size={15} aria-hidden="true" className="shrink-0 text-(--bk-accent)" />}
                {item}
                {/* Trailing, so a wrapped line never starts with a separator. */}
                {i < BREAKFAST_ITEMS.length - 1 && (
                  <span aria-hidden="true" className="text-(--bk-text-subtle)">
                    ·
                  </span>
                )}
              </li>
            ))}
          </ul>

          <dl className="mt-3 space-y-2 text-sm">
            {ORDERING_RULE.map((section) => (
              <div key={section.heading}>
                <dt className="font-medium">{section.heading}</dt>
                <dd className="leading-relaxed text-(--bk-text-muted)">{section.body}</dd>
              </div>
            ))}
          </dl>
          {MORE_POLICY.length > 0 && (
            <details className="mt-2 text-sm">
              <summary className="cursor-pointer font-medium text-(--bk-link) underline decoration-1 underline-offset-4 hover:no-underline">
                More about breakfast
              </summary>
              <dl className="mt-2 space-y-2">
                {MORE_POLICY.map((section) => (
                  <div key={section.heading}>
                    <dt className="font-medium">{section.heading}</dt>
                    <dd className="leading-relaxed text-(--bk-text-muted)">{section.body}</dd>
                  </div>
                ))}
              </dl>
            </details>
          )}

          {note && <p className="mt-3 text-sm text-(--bk-text-muted)">{note}</p>}
        </div>
      </div>

      <div className="flex border-t border-(--bk-border) px-3 py-3 sm:justify-end sm:px-4">
        {action ?? (
          <a
            href={whatsappHref(whatsappMessage ?? breakfastWhatsAppMessage())}
            target="_blank"
            rel="noopener noreferrer"
            className={`${BTN_PRIMARY} min-h-11 w-full text-sm sm:w-auto`}
          >
            <MessageCircle size={16} aria-hidden="true" />
            Order breakfast on WhatsApp
          </a>
        )}
      </div>
    </article>
  );
}
