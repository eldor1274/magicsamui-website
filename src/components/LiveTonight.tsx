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

  // The row's space is reserved from first paint — popping it in after the
  // rates fetch shifted every card below it (the site's main CLS source).
  return (
    <div className="flex items-center justify-between border-t border-stone-100 pt-2 text-xs">
      <span className="text-ink-soft">
        {rate ? (
          <>
            Tonight: <span className="font-medium text-ink">฿{rate.price.toLocaleString()}</span>
          </>
        ) : (
          <span
            aria-hidden
            className="inline-block h-3 w-24 animate-pulse rounded bg-stone-100 align-middle"
          />
        )}
      </span>
      {rate ? (
        rate.available ? (
          <span className="rounded-full bg-pool/10 px-2 py-0.5 font-medium text-pool">Available</span>
        ) : (
          <span className="rounded-full bg-stone-100 px-2 py-0.5 font-medium text-ink-soft">
            Booked tonight
          </span>
        )
      ) : (
        <span aria-hidden className="invisible rounded-full px-2 py-0.5 font-medium">
          Available
        </span>
      )}
    </div>
  );
}
