"use client";

import { useEffect, useState, type ComponentType } from "react";

// Loads the scroll recorder only when the URL carries ?diag=1, so its code is
// a separate chunk that normal visitors never download.
export default function ScrollDiagGate() {
  const [Panel, setPanel] = useState<ComponentType | null>(null);

  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has("diag")) return;
    let alive = true;
    import("./ScrollDiag").then((m) => {
      if (alive) setPanel(() => m.default);
    });
    return () => {
      alive = false;
    };
  }, []);

  return Panel ? <Panel /> : null;
}
