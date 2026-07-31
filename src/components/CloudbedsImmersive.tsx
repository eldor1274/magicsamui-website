"use client";

import { useEffect, useState } from "react";
import { site } from "@/data/site";

export default function CloudbedsImmersive() {
  const [isLocal, setIsLocal] = useState<boolean | null>(null);

  useEffect(() => {
    // Cloudbeds only serves its widgets to whitelisted public domains,
    // and localhost can't be whitelisted — skip the embed in local dev.
    setIsLocal(["localhost", "127.0.0.1"].includes(window.location.hostname));
  }, []);

  if (isLocal === null) return <div style={{ minHeight: 400 }} />;

  if (isLocal) {
    return (
      <div className="rounded-2xl bg-stone-100 p-10 text-center text-ink-soft">
        Booking engine — shows on the live site only
      </div>
    );
  }

  return (
    <cb-immersive-experience
      mode="standard"
      property-code={site.cloudbedsPropertyCode}
      currency="thb"
    />
  );
}
