// The rate rows' link to the breakfast card on the booking page (owner, 16 Nov 2026): the link's words and its
// target id; that the booking page passes the id on the very condition on which it passes the card (add-ons off:
// every Stripe and Beam mode, never the demo); that the results list hands the id to the rate rows only while it
// renders the card; and that the link scrolls the card's heading clear of the sticky header and moves focus to
// it without touching the page's URL or history. paymentCopy.test.ts renders the list with and without the card.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BEAM_LIVE_ENV, BEAM_TEST_ENV } from "./beamTestkit.ts";
import { BREAKFAST_CARD_HEADING_ID, BREAKFAST_LINK_LABEL } from "./breakfastLink.ts";
import { getPublicBookingConfig } from "./config.ts";
import { STRIPE_LIVE_ENV, STRIPE_TEST_ENV } from "./testkit.ts";

/** A booking component's source with its whitespace collapsed, so a pin does not depend on line breaks. */
const flat = (path: string) => readFileSync(new URL(`../../components/booking/${path}`, import.meta.url), "utf8").replace(/\s+/g, " ");

test("breakfast link: its words carry no price (the card states it, from its own constant), and its target is the id of the card's heading, which can take focus", () => {
  assert.equal(BREAKFAST_LINK_LABEL, "Breakfast on request: see details");
  assert.doesNotMatch(BREAKFAST_LINK_LABEL, /\d|THB|฿/);
  assert.equal(BREAKFAST_CARD_HEADING_ID, "breakfast-card-title");
  const card = flat("breakfast/BreakfastCard.tsx");
  assert.ok(card.includes("headingId = BREAKFAST_CARD_HEADING_ID,"), "the card's default heading id is the link's target");
  assert.ok(card.includes('<Heading id={headingId} tabIndex={-1} className={`bk-heading text-lg leading-snug focus:outline-none sm:text-xl${eyebrow ? " mt-1" : ""}`}>'));
  // The price stays the card's: one constant, built from the catalogue.
  assert.ok(card.includes("export const BREAKFAST_PRICE_TEXT = `${PRICE} ${PER}`;"));
});

test("breakfast link, the condition: the booking page passes the heading's id exactly when it passes the card (add-ons off), and the results list hands it to the rate rows only while it renders that card", () => {
  const app = flat("BookingApp.tsx");
  // One condition for both props, one right after the other.
  assert.match(app, /afterRooms=\{ addonsEnabled \? undefined : \( <BreakfastCard [^<]* \/> \) \} (\/\/ [^{}]* )?breakfastCardId=\{addonsEnabled \? undefined : BREAKFAST_CARD_HEADING_ID\} \/>/);
  assert.equal(app.split("breakfastCardId=").length - 1, 1);
  // Add-ons are off in every Stripe and Beam mode (the card and the link), on in the demo (neither).
  for (const env of [STRIPE_LIVE_ENV, STRIPE_TEST_ENV, BEAM_LIVE_ENV, BEAM_TEST_ENV]) assert.equal(getPublicBookingConfig(env).addonsEnabled, false);
  assert.equal(getPublicBookingConfig({}).addonsEnabled, true);
  const list = flat("results/ResultsList.tsx");
  // The same condition as the card's own line, and the id reaches every room card.
  assert.ok(list.includes("const breakfastLinkId = afterRooms && (available.length > 0 || enquiry.length > 0) ? breakfastCardId : undefined;"));
  assert.ok(list.includes("{(available.length > 0 || enquiry.length > 0) && afterRooms}"));
  assert.equal(list.split("breakfastCardId={breakfastLinkId}").length - 1, 1);
});

test("breakfast link, the row: a text button in the rate's description column that scrolls the card's heading clear of the sticky header and moves focus to it, with no hash and no history entry", () => {
  const card = flat("results/RoomOfferCard.tsx");
  // In the description column: right after the rate's description, before the price column (whose lines paymentCopy.test.ts parses).
  assert.ok(
    card.includes(
      '{plan.shortDescription}</p> {breakfastCardId && ( <p className="mt-1"> <button type="button" onClick={() => showBreakfastCard(breakfastCardId)} className={`${BTN_LINK} text-left text-xs`}> {BREAKFAST_LINK_LABEL} </button> </p> )} </div> <div className="col-span-2 flex items-center justify-between gap-4 sm:contents">',
    ),
  );
  assert.equal(card.split("BREAKFAST_LINK_LABEL").length - 1, 2, "imported, and used once");
  // Every rate row gets the id the room card was given.
  assert.equal(card.split("breakfastCardId={breakfastCardId}").length - 1, 1);
  // Scroll first (smooth unless the visitor asked for less motion), then focus without a second jump.
  assert.ok(card.includes('const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches; heading.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" }); heading.focus({ preventScroll: true });'));
  // The booking flow owns this page's history entries: no "#..." link, no hash, no history call.
  assert.doesNotMatch(card, /href=\{?[`"']#|location\.hash|pushState|replaceState/);
  // The page's scroll padding keeps the heading clear of the sticky header (every booking page but the homepage's search bar).
  const css = readFileSync(new URL("../../components/booking/booking.css", import.meta.url), "utf8").replace(/\s+/g, " ");
  assert.ok(css.includes("html:has(.booking-app):not(:has(.bk-home-search)) { scroll-padding-top: 6rem;"));
});
