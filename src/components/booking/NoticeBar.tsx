"use client";

// OWNER: foundation. One-line flow notices (payment cancelled, cart cleared...).
// Not a live region itself: a status region that mounts already filled is
// often not read, so BookingApp announces each notice through its persistent
// live region, and moves focus to the step heading when it is dismissed.

import { Info, X } from "lucide-react";
import type { Notice } from "./state";

export interface NoticeBarProps {
  notice: Notice;
  onDismiss: () => void;
}

export default function NoticeBar({ notice, onDismiss }: NoticeBarProps) {
  return (
    <div className="flex items-start gap-3 rounded-(--bk-radius-control) border border-(--bk-banner-border) bg-(--bk-warning-soft) px-4 py-3 text-sm text-(--bk-text)">
      <Info size={18} className="mt-0.5 shrink-0 text-(--bk-warning)" aria-hidden="true" />
      <p className="min-w-0 flex-1">{notice.message}</p>
      {/* 44px target; the negative margins keep the bar's height. */}
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss message"
        className="-my-2.5 -mr-2.5 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-(--bk-text-muted) hover:bg-(--bk-surface-sunken) hover:text-(--bk-text)"
      >
        <X size={16} aria-hidden="true" />
      </button>
    </div>
  );
}
