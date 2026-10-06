"use client";

// OWNER: ui-checkout
// Slim banner above the booking app saying plainly what this page is running
// on: the payment provider (Stripe / Beam / simulated), the mode (demo / MOCK /
// test / live / locked), where availability comes from and whether a real
// Cloudbeds reservation is written - plus links to switch between the two
// themes. Not shown to guests on a fully live Stripe page (nothing to warn
// about there). Keep PreviewBannerProps stable (new props are optional).

import { CreditCard, Database, FlaskConical, Lock, MessageCircle, Palette, TriangleAlert } from "lucide-react";
import { modeKind, previewHeadline } from "@/lib/booking/paymentCopy";
import type { DataSource, PaymentMode, PaymentProvider, ThemeName } from "@/lib/booking/types";

export interface PreviewBannerProps {
  paymentMode: PaymentMode;
  paymentStatus: "ok" | "locked";
  /** null until the first availability response says where data came from. */
  dataSource: DataSource | null;
  theme: ThemeName;
  /** Same page URL with ?theme= set, for each theme. */
  themeHref: Record<ThemeName, string>;
  /** Configured provider (shown even when payments are locked). Defaults from paymentMode. */
  provider?: PaymentProvider;
  /** Whether a real Cloudbeds reservation is written ("live"), simulated ("mock") or not at all ("none"). */
  cloudbedsWrites?: "live" | "mock" | "none";
  /** WhatsApp fallback shown with the locked message. */
  whatsappUrl?: string;
}

const THEME_LABELS: Record<ThemeName, string> = { magic: "Magic", classic: "Classic" };

const PROVIDER_LABEL: Record<PaymentProvider, string> = { stripe: "Stripe", beam: "Beam", demo: "Simulated payments" };

const MODE_LABEL = { demo: "Demo", mock: "MOCK", test: "Test mode", live: "LIVE" } as const;

const DATA_SOURCE: Record<DataSource, { label: string; tone: "ok" | "info" | "warn" }> = {
  cloudbeds: { label: "Live Cloudbeds availability", tone: "ok" },
  demo: { label: "Simulated availability", tone: "info" },
  "demo-fallback": { label: "Cloudbeds unavailable - showing simulated availability", tone: "warn" },
};

const WRITES_LABEL: Record<"live" | "mock" | "none", string> = {
  live: "Real Cloudbeds reservations",
  mock: "Reservation simulated",
  none: "No reservation is made",
};

const CHIP = "inline-flex items-center gap-1.5 rounded-(--bk-radius-pill) px-2.5 py-1 font-medium";

export default function PreviewBanner({
  paymentMode,
  paymentStatus,
  dataSource,
  theme,
  themeHref,
  provider,
  cloudbedsWrites,
  whatsappUrl,
}: PreviewBannerProps) {
  const locked = paymentStatus === "locked";
  // A fully live Stripe page is the real booking page: no preview banner for guests.
  if (!locked && paymentMode === "stripe-live") return null;

  const source = dataSource ? DATA_SOURCE[dataSource] : null;
  const kind = modeKind(paymentMode);
  const isLive = !locked && kind === "live";
  const shownProvider: PaymentProvider = provider ?? (paymentMode.startsWith("stripe") ? "stripe" : paymentMode.startsWith("beam") ? "beam" : "demo");
  const writes = locked ? "none" : (cloudbedsWrites ?? "none");

  return (
    <section
      aria-label="About this preview"
      className={`rounded-(--bk-radius-control) border px-4 py-2.5 text-sm ${
        isLive
          ? "border-(--bk-danger) bg-(--bk-danger-soft) text-(--bk-text)"
          : "border-(--bk-banner-border) bg-(--bk-banner-bg) text-(--bk-banner-text)"
      }`}
    >
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between md:gap-4">
        <p className="flex min-w-0 items-start gap-2">
          {isLive ? (
            <TriangleAlert size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-(--bk-danger)" />
          ) : (
            <FlaskConical size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-(--bk-warning)" />
          )}
          <span>
            <strong className="font-semibold">Preview of your own booking engine</strong> -{" "}
            {locked
              ? "payments are locked, so you can browse rooms but paying is disabled and nothing can be charged."
              : previewHeadline({ paymentMode, dataSource, cloudbedsWrites: writes })}
          </span>
        </p>

        <nav aria-label="Preview theme" className="flex shrink-0 items-center gap-2 text-xs">
          <Palette size={14} aria-hidden="true" className="opacity-70" />
          <span className="opacity-80">Theme</span>
          <span className="inline-flex rounded-(--bk-radius-pill) border border-(--bk-banner-border) bg-(--bk-surface) p-0.5">
            {(Object.keys(THEME_LABELS) as ThemeName[]).map((t) =>
              t === theme ? (
                <span
                  key={t}
                  aria-current="true"
                  className="rounded-(--bk-radius-pill) bg-(--bk-accent) px-3 py-1 font-medium text-(--bk-accent-contrast)"
                >
                  {THEME_LABELS[t]}
                </span>
              ) : (
                <a
                  key={t}
                  href={themeHref[t]}
                  className="relative rounded-(--bk-radius-pill) px-3 py-1 before:absolute before:inset-x-0 before:-inset-y-2.5 font-medium text-(--bk-text-muted) transition-colors hover:text-(--bk-text)"
                >
                  {THEME_LABELS[t]}
                  <span className="bk-sr-only"> theme</span>
                </a>
              ),
            )}
          </span>
        </nav>
      </div>

      <ul aria-label="Preview settings" className="mt-2 flex flex-wrap gap-2 text-xs">
        <li className={`${CHIP} bg-(--bk-surface) text-(--bk-text)`}>
          <CreditCard size={12} aria-hidden="true" />
          {PROVIDER_LABEL[shownProvider]} · {locked ? "Locked" : MODE_LABEL[kind]}
        </li>
        {source && (
          <li
            className={`${CHIP} ${
              source.tone === "warn"
                ? "bg-(--bk-warning-soft) text-(--bk-warning)"
                : source.tone === "ok"
                  ? "bg-(--bk-success-soft) text-(--bk-success)"
                  : "bg-(--bk-surface) text-(--bk-text-muted)"
            }`}
          >
            <Database size={12} aria-hidden="true" />
            {source.label}
          </li>
        )}
        {shownProvider === "stripe" && !locked && (
          <li className={`${CHIP} ${writes === "live" ? "bg-(--bk-warning-soft) text-(--bk-warning)" : "bg-(--bk-surface) text-(--bk-text-muted)"}`}>
            <Database size={12} aria-hidden="true" />
            {WRITES_LABEL[writes]}
          </li>
        )}
        {locked && (
          <li className={`${CHIP} bg-(--bk-danger-soft) text-(--bk-danger)`}>
            <Lock size={12} aria-hidden="true" />
            Payments locked: a payment setting is missing or not allowed here - see docs/booking-engine.md.
          </li>
        )}
        {locked && whatsappUrl && (
          <li>
            <a
              href={whatsappUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={`${CHIP} bg-(--bk-surface) text-(--bk-text) underline-offset-2 hover:underline`}
            >
              <MessageCircle size={12} aria-hidden="true" />
              Book on WhatsApp
            </a>
          </li>
        )}
      </ul>
    </section>
  );
}
