"use client";

// OWNER: foundation. Theme root for every booking-preview surface. Sets
// data-theme on a .booking-app element (tokens in booking.css) and exposes
// the theme to overlays that portal to <body> (they must wrap their content
// in <BookingThemeScope> so the same CSS variables apply).

import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import { Poppins } from "next/font/google";
import type { ThemeName } from "@/lib/booking/types";
import "./booking.css";

/**
 * Cloudbeds' typeface for the "classic" theme (exposed as --font-classic; see
 * booking.css). Not preloaded: the browser only fetches it when the classic
 * theme actually uses it, so the default "magic" theme pays nothing.
 */
const classicFont = Poppins({
  variable: "--font-classic",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
  preload: false,
});

const ThemeContext = createContext<ThemeName>("magic");

export function useBookingTheme(): ThemeName {
  return useContext(ThemeContext);
}

export interface BookingThemeRootProps {
  theme: ThemeName;
  className?: string;
  children: ReactNode;
}

export default function BookingThemeRoot({ theme, className = "", children }: BookingThemeRootProps) {
  return (
    <ThemeContext.Provider value={theme}>
      <div className={`booking-app ${classicFont.variable} ${className}`} data-theme={theme}>
        {children}
      </div>
    </ThemeContext.Provider>
  );
}

/** Re-applies the theme tokens inside portals (modals, sheets, popovers). */
export function BookingThemeScope({ children, className = "" }: { children: ReactNode; className?: string }) {
  const theme = useBookingTheme();
  return (
    <div className={`booking-app ${classicFont.variable} ${className}`} data-theme={theme} style={{ background: "transparent" }}>
      {children}
    </div>
  );
}
