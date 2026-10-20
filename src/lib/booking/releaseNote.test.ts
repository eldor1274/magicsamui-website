import assert from "node:assert/strict";
import { test } from "node:test";

import { releaseNoteText } from "./sweep.ts";

// The sweeper writes WHY a hold was given back into the Cloudbeds note (2026-10-20:
// a guest's failed website attempt left no trace once the server logs expired).
test("no session at all: the booking page failed before Stripe", () => {
  assert.match(releaseNoteText([]), /no payment page was ever created/);
});

test("expired session without a PaymentIntent: the page was created, nothing attempted", () => {
  const note = releaseNoteText([{ session: { payment_intent: null }, state: "expired" }]);
  assert.match(note, /no payment was ever attempted/);
});

test("expired session with a PaymentIntent: a payment was started but never completed", () => {
  const note = releaseNoteText([{ session: { payment_intent: "pi_123" }, state: "expired" }]);
  assert.match(note, /started but never completed/);
});

test("failed session wins over an expired one", () => {
  const note = releaseNoteText([
    { session: { payment_intent: null }, state: "expired" },
    { session: { payment_intent: "pi_123" }, state: "failed" },
  ]);
  assert.match(note, /did not go through/);
});

test("every note says nothing was charged", () => {
  for (const sessions of [[], [{ session: { payment_intent: null }, state: "expired" as const }]]) {
    assert.match(releaseNoteText(sessions), /Nothing was charged/);
  }
});
