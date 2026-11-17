"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Tag } from "lucide-react";

// Shown above the booking engine. When a guest arrives through a link we
// sent (chat/WhatsApp) carrying ?promo=..., the engine applies the code
// itself and this says so - conditionally, because this page can't see
// whether the engine accepted it (a mistyped or expired code changes no
// price). Otherwise it says where a code goes. It names no code and
// promises no price (rate parity, 2026-11-16).
export default function PromoHint() {
  const [applied, setApplied] = useState<boolean | null>(null);

  useEffect(() => {
    setApplied(new URLSearchParams(window.location.search).has("promo"));
  }, []);

  // Reserve the real height: on phones the applied note wraps to two lines
  // (64px; keep it that short - about 70 characters fit two lines at 360px);
  // the old 44px placeholder let everything below drop 20px at hydration.
  // The shorter line below keeps the same minimum height, so it can't move
  // the page either when it fits on one line.
  if (applied === null) return <div className="min-h-[64px] sm:min-h-[44px]" />;

  if (applied) {
    return (
      <p className="flex items-center gap-2 rounded-xl bg-pool/10 px-4 py-3 text-sm text-pool">
        <CheckCircle2 size={18} className="shrink-0" />
        Where your promo code applies, the prices below already include it.
      </p>
    );
  }

  return (
    <p className="flex min-h-[64px] items-center gap-2 rounded-xl bg-sand/20 px-4 py-3 text-sm text-ink sm:min-h-[44px]">
      <Tag size={18} className="shrink-0 text-pool" />
      Have a promo code? Enter it at checkout.
    </p>
  );
}
