import { test } from "node:test";
import assert from "node:assert/strict";
import { CATALOGUE, cartConflict, getBookableRooms, hasUnitConflict, isBookableSlug, sharedUnits } from "./catalogue.ts";
import { ROOM_TYPE_TO_SLUG } from "../../data/cloudbeds.ts";

test("bookable rooms are exactly the 11 with a Cloudbeds room type", () => {
  const bookable = getBookableRooms().map((r) => r.slug).sort();
  assert.deepEqual(bookable, Object.values(ROOM_TYPE_TO_SLUG).sort());
  assert.equal(isBookableSlug("tuxedo-3br"), false);
  assert.ok(CATALOGUE.find((r) => r.slug === "tuxedo-3br"), "tuxedo-3br still listed for enquiries");
});

test("catalogue uses site room data", () => {
  const sunrise = CATALOGUE.find((r) => r.slug === "sunrise-suite");
  assert.ok(sunrise);
  assert.equal(sunrise.cloudbedsRoomTypeId, "462960");
  assert.equal(sunrise.maxGuests, 2);
  assert.ok(sunrise.gallery.length > 0);
  assert.equal(CATALOGUE.find((r) => r.slug === "magic-1-villa")?.maxGuests, 10);
});

test("combination rooms conflict with the suites they contain", () => {
  assert.deepEqual(sharedUnits("tower-club-3br", "honeymoon-suite"), ["HM"]);
  assert.deepEqual(sharedUnits("island-view-3br", "seaview-suite"), ["SVL"]);
  assert.deepEqual(sharedUnits("garden-suite", "sunrise-suite"), []);
  assert.equal(hasUnitConflict(["magic-1-villa", "garden-suite"]), true);
  assert.equal(hasUnitConflict(["seaview-suite", "seaview-2br"]), true);
  assert.equal(hasUnitConflict(["tuxedo", "tuxedo-1br"]), true);
  assert.equal(hasUnitConflict(["tuxedo", "tuxedo-seaview-unit"]), false);
  assert.equal(hasUnitConflict(["honeymoon-suite", "sunrise-suite", "garden-suite", "seaview-2br"]), false);
  assert.equal(hasUnitConflict(["garden-suite", "garden-suite"]), true);
});

test("cartConflict explains why a room can't be added", () => {
  assert.equal(cartConflict("garden-suite", ["honeymoon-suite"]), null);
  assert.equal(cartConflict("honeymoon-suite", ["honeymoon-suite"])?.message, "Already in your reservation");
  const c = cartConflict("tower-club-3br", ["honeymoon-suite"]);
  assert.equal(c?.withSlug, "honeymoon-suite");
  assert.match(c?.message ?? "", /^Shares space with /);
});
