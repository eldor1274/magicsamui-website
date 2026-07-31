"use client";

import { useEffect, useState } from "react";

// Renders a muted looping video only on desktop-sized screens (and only for
// users without a reduced-motion preference). On phones nothing is rendered,
// so no video bytes are ever downloaded there.
export default function DesktopVideo({
  src,
  className = "",
}: {
  src: string;
  className?: string;
}) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const wide = window.matchMedia("(min-width: 640px)");
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setShow(wide.matches && !reduced.matches);
    update();
    wide.addEventListener("change", update);
    reduced.addEventListener("change", update);
    return () => {
      wide.removeEventListener("change", update);
      reduced.removeEventListener("change", update);
    };
  }, []);

  if (!show) return null;

  return (
    <video autoPlay muted loop playsInline preload="metadata" className={className}>
      <source src={src} type="video/mp4" />
    </video>
  );
}
