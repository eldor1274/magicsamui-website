"use client";

import Script from "next/script";
import { useEffect, useState } from "react";
import { site } from "@/data/site";

// Loads the Cloudbeds widget script only on public domains — Cloudbeds
// rejects localhost (can't be whitelisted), which would just log errors.
export default function CloudbedsScript() {
  const [load, setLoad] = useState(false);

  useEffect(() => {
    setLoad(!["localhost", "127.0.0.1"].includes(window.location.hostname));
  }, []);

  if (!load) return null;

  return <Script src={site.cloudbedsImmersiveScript} strategy="lazyOnload" />;
}
