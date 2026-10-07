"use client";

// Code-split entry for the homepage quick search. The homepage picks
// HomeSearch (BOOKING_ENGINE=own) or the Cloudbeds widget (default); a static
// import would ship HomeSearch's code on every homepage load even when the
// Cloudbeds widget is shown. next/dynamic keeps it out of the default
// homepage. HomeSearch itself is server-rendered (its same-size placeholder);
// the search bar inside it loads in the browser only (see HomeSearch.tsx).

import dynamic from "next/dynamic";
import type { HomeSearchProps } from "./HomeSearch";

const HomeSearchLazy = dynamic<HomeSearchProps>(() => import("./HomeSearch"));

export default HomeSearchLazy;
