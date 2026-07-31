"use client";

import { useEffect, useState } from "react";

type Rates = Record<string, { price: number; available: boolean }>;

// One fetch shared by every card on the page.
let ratesPromise: Promise<Rates> | null = null;
function loadRates(): Promise<Rates> {
  if (!ratesPromise) {
    ratesPromise = fetch("/api/rates")
      .then((r) => (r.ok ? r.json() : {}))
      .catch(() => ({}));
  }
  return ratesPromise;
}

export default function LiveTonight({ slug }: { slug: string }) {
  const [rate, setRate] = useState<{ price: number; available: boolean } | null>(null);

  useEffect(() => {
    let mounted = true;
    loadRates().then((rates) => {
      if (mounted && rates[slug]) setRate(rates[slug]);
    });
    return () => {
      mounted = false;
    };
  }, [slug]);

  if (!rate) return null;

  return (
    <div className="flex items-center justify-between border-t border-stone-100 pt-2 text-xs">
      <span className="text-ink-soft">
        Tonight: <span className="font-medium text-ink">฿{rate.price.toLocaleString()}</span>
      </span>
      {rate.available ? (
        <span className="rounded-full bg-pool/10 px-2 py-0.5 font-medium text-pool">Available</span>
      ) : (
        <span className="rounded-full bg-stone-100 px-2 py-0.5 font-medium text-ink-soft">
          Booked tonight
        </span>
      )}
    </div>
  );
}
