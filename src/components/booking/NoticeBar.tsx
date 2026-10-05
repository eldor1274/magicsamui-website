"use client";

// OWNER: foundation. One-line flow notices (payment cancelled, cart cleared...).

import { Info, X } from "lucide-react";
import type { Notice } from "./state";

export interface NoticeBarProps {
  notice: Notice;
  onDismiss: () => void;
}

export default function NoticeBar({ notice, onDismiss }: NoticeBarProps) {
  return (
    <div
      role="status"
      className="flex items-start gap-3 rounded-(--bk-radius-control) border border-(--bk-banner-border) bg-(--bk-warning-soft) px-4 py-3 text-sm text-(--bk-text)"
    >
      <Info size={18} className="mt-0.5 shrink-0 text-(--bk-warning)" aria-hidden="true" />
      <p className="flex-1">{notice.message}</p>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss message"
        className="-m-1 rounded-full p-1 text-(--bk-text-muted) hover:text-(--bk-text)"
      >
        <X size={16} aria-hidden="true" />
      </button>
    </div>
  );
}
