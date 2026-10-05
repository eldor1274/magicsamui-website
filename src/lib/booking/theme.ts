// Booking preview themes (isomorphic; safe in server components).

import type { ThemeName } from "./types.ts";

export const THEMES: ThemeName[] = ["magic", "classic"];

/** ?theme=classic -> "classic"; anything else -> "magic" (site brand, default). */
export function parseTheme(value: string | string[] | null | undefined): ThemeName {
  const v = Array.isArray(value) ? value[0] : value;
  return v === "classic" ? "classic" : "magic";
}
