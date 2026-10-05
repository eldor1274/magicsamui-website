"use client";

// OWNER: ui-checkout
// Slim banner above the booking app saying plainly what this preview is:
// payment mode (demo / Beam playground / live / locked), where availability
// comes from, and links to switch between the two themes.
// Keep PreviewBannerProps stable.

import { Database, FlaskConical, Lock, Palette, TriangleAlert } from "lucide-react";
import type { DataSource, PaymentMode, ThemeName } from "@/lib/booking/types";

export interface PreviewBannerProps {
  paymentMode: PaymentMode;
  paymentStatus: "ok" | "locked";
  /** null until the first availability response says where data came from. */
  dataSource: DataSource | null;
  theme: ThemeName;
  /** Same page URL with ?theme= set, for each theme. */
  themeHref: Record<ThemeName, string>;
}

const THEME_LABELS: Record<ThemeName, string> = { magic: "Magic", classic: "Classic" };

function headline(paymentMode: PaymentMode, dataSource: DataSource | null): string {
  const live = dataSource === "cloudbeds";
  switch (paymentMode) {
    case "demo":
      return live
        ? "demo mode: live Cloudbeds availability, simulated payment - no real payment is taken."
        : "demo mode: availability and prices are simulated, no real payment is taken.";
    case "beam-playground":
      return live
        ? "Beam test mode: live Cloudbeds availability, payments go to Beam's playground - use Beam test cards only, no real money moves."
        : "Beam test mode: simulated availability, payments go to Beam's playground - use Beam test cards only, no real money moves.";
    case "beam-live":
      return "LIVE payments: real cards are charged through Beam.";
  }
}

const DATA_SOURCE: Record<DataSource, { label: string; tone: "ok" | "info" | "warn" }> = {
  cloudbeds: { label: "Live Cloudbeds availability (read-only)", tone: "ok" },
  demo: { label: "Simulated availability", tone: "info" },
  "demo-fallback": { label: "Cloudbeds unavailable - showing simulated availability", tone: "warn" },
};

export default function PreviewBanner({ paymentMode, paymentStatus, dataSource, theme, themeHref }: PreviewBannerProps) {
  const source = dataSource ? DATA_SOURCE[dataSource] : null;
  const isLive = paymentMode === "beam-live";

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
            <strong className="font-semibold">Preview of your own booking engine with Beam payments</strong> -{" "}
            {paymentStatus === "locked"
              ? "payments are locked, so you can browse rooms but paying is disabled."
              : headline(paymentMode, dataSource)}
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

      {(source || paymentStatus === "locked") && (
        <div className="mt-2 flex flex-wrap gap-2 text-xs">
          {source && (
            <span
              className={`inline-flex items-center gap-1.5 rounded-(--bk-radius-pill) px-2.5 py-1 font-medium ${
                source.tone === "warn"
                  ? "bg-(--bk-warning-soft) text-(--bk-warning)"
                  : source.tone === "ok"
                    ? "bg-(--bk-success-soft) text-(--bk-success)"
                    : "bg-(--bk-surface) text-(--bk-text-muted)"
              }`}
            >
              <Database size={12} aria-hidden="true" />
              {source.label}
            </span>
          )}
          {paymentStatus === "locked" && (
            <span className="inline-flex items-center gap-1.5 rounded-(--bk-radius-pill) bg-(--bk-danger-soft) px-2.5 py-1 font-medium text-(--bk-danger)">
              <Lock size={12} aria-hidden="true" />
              Payments locked: a payment setting (Beam keys or BOOKING_TOKEN_SECRET) is missing or not allowed here - see
              docs/booking-beam-preview.md.
            </span>
          )}
        </div>
      )}
    </section>
  );
}
