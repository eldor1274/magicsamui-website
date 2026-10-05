"use client";

// OWNER: foundation. Back arrow + step title (Cloudbeds-style wayfinding).

import { ArrowLeft } from "lucide-react";

export interface StepHeaderProps {
  title: string;
  /** Accessible label for the back button, e.g. "Go back to Choose your room". */
  backLabel?: string;
  onBack?: () => void;
  subtitle?: string;
}

export default function StepHeader({ title, backLabel, onBack, subtitle }: StepHeaderProps) {
  return (
    <div className="flex items-start gap-3">
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          aria-label={backLabel ?? "Go back"}
          className="mt-0.5 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-(--bk-radius-control) border border-(--bk-border-strong) bg-(--bk-surface) text-(--bk-text) transition-colors hover:border-(--bk-accent) hover:text-(--bk-accent)"
        >
          <ArrowLeft size={18} aria-hidden="true" />
        </button>
      )}
      <div className="min-w-0">
        <h2 className="bk-heading text-2xl text-(--bk-text)">{title}</h2>
        {subtitle && <p className="mt-1 text-sm text-(--bk-text-muted)">{subtitle}</p>}
      </div>
    </div>
  );
}
