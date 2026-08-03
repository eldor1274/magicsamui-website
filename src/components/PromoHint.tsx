"use client";

import { useEffect, useState } from "react";
import { BadgePercent, CheckCircle2 } from "lucide-react";

// Shown above the booking engine. When a guest arrives through a link we
// sent (chat/WhatsApp) carrying ?promo=..., the engine auto-applies the
// code and this confirms it; otherwise it invites entering the code.
export default function PromoHint() {
  const [applied, setApplied] = useState<boolean | null>(null);

  useEffect(() => {
    setApplied(new URLSearchParams(window.location.search).has("promo"));
  }, []);

  if (applied === null) return <div style={{ minHeight: 44 }} />;

  if (applied) {
    return (
      <p className="flex items-center gap-2 rounded-xl bg-pool/10 px-4 py-3 text-sm text-pool">
        <CheckCircle2 size={18} className="shrink-0" />
        Your DIRECT discount is applied — the prices below already include it.
      </p>
    );
  }

  return (
    <p className="flex items-center gap-2 rounded-xl bg-sand/20 px-4 py-3 text-sm text-ink">
      <BadgePercent size={18} className="shrink-0 text-pool" />
      Enter code&nbsp;<span className="font-semibold tracking-wide">DIRECT</span>&nbsp;at
      checkout for our best direct rate.
    </p>
  );
}
