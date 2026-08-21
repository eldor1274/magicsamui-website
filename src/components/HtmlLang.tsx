"use client";

import { useEffect } from "react";

// The root layout owns <html lang="en"> and nested routes can't change it,
// so the localized landings swap the attribute here (content already carries
// its own lang/dir wrapper). Restored on unmount for soft navigations back.
export default function HtmlLang({ lang }: { lang: string }) {
  useEffect(() => {
    const prev = document.documentElement.lang;
    document.documentElement.lang = lang;
    return () => {
      document.documentElement.lang = prev;
    };
  }, [lang]);

  return null;
}
