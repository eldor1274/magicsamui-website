"use client";

// OWNER: foundation. Back arrow + step title (Cloudbeds-style wayfinding).

import { ArrowLeft } from "lucide-react";

export interface StepHeaderProps {
  title: string;
  /** Accessible label for the back button, e.g. "Go back to Choose your room". */
  backLabel?: string;
  onBack?: () => void;
  subtitle?: string;
  /** id for the <h2> (the step section is labelled by it; BookingApp focuses it on step changes). */
  headingId?: string;
}

export default function StepHeader({ title, backLabel, onBack, subtitle, headingId }: StepHeaderProps) {
  return (
    // Centred on the arrow like Cloudbeds; with a subtitle the arrow lines up with the title row instead.
    <div className={`flex gap-3 ${subtitle ? "items-start" : "items-center"}`}>
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          aria-label={backLabel ?? "Go back"}
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-(--bk-radius-control) border border-(--bk-border-strong) bg-(--bk-surface) text-(--bk-text) transition-colors hover:border-(--bk-accent) hover:text-(--bk-accent)"
        >
          <ArrowLeft size={18} aria-hidden="true" />
        </button>
      )}
      <div className="min-w-0">
        <h2 id={headingId} tabIndex={-1} className="bk-heading text-2xl text-(--bk-text) focus:outline-none">
          {title}
        </h2>
        {subtitle && <p className="mt-1 text-sm text-(--bk-text-muted)">{subtitle}</p>}
      </div>
    </div>
  );
}
