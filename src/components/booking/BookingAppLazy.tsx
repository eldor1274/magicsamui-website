"use client";

// Code-split entry for BookingApp. /booking imports OwnBookingPage even when
// it renders the Cloudbeds engine (BOOKING_ENGINE unset or "cloudbeds"), and a
// Server Component's static import of a Client Component puts that component's
// JavaScript and CSS on the route whether it renders or not. Loading it through
// next/dynamic here keeps the default /booking page exactly as before: the
// booking engine's code is only fetched on pages that actually render it
// (server-rendered as usual, so nothing changes for the guest).

import dynamic from "next/dynamic";
import type { BookingAppProps } from "./BookingApp";

const BookingAppLazy = dynamic<BookingAppProps>(() => import("./BookingApp"));

export default BookingAppLazy;
