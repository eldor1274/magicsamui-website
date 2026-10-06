"use client";

// Code-split entry for the homepage quick search. The homepage picks
// OwnDatePicker (BOOKING_ENGINE=own) or the Cloudbeds widget (default); a
// static import would ship OwnDatePicker's code on every homepage load even
// when the Cloudbeds widget is shown. next/dynamic keeps it out of the default
// homepage; when it is used it is still server-rendered at full size.

import dynamic from "next/dynamic";
import type { OwnDatePickerProps } from "./OwnDatePicker";

const OwnDatePickerLazy = dynamic<OwnDatePickerProps>(() => import("./OwnDatePicker"));

export default OwnDatePickerLazy;
