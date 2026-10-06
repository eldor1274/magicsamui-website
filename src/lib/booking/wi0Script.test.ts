// The read-only WI-0 owner script (scripts/cloudbeds-wi0-check.mjs), run as a
// child process with `fetch` replaced by an in-memory stub: nothing leaves
// this machine and no key is needed. Only the verdicts the runbook relies on
// are checked here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../../../scripts/cloudbeds-wi0-check.mjs", import.meta.url));
const CHECK_IN = "2027-12-05";
const STAY = ["2027-12-05", "2027-12-06", "2027-12-07"];

type Json = Record<string, unknown>;

/** Runs the script with every Cloudbeds call answered from `answers` (by endpoint; getRatePlans by roomTypeID). */
function runScript(answers: { getAvailableRoomTypes: Json; getRatePlans?: Record<string, Json> }): string {
  const stub = `
const ANSWERS = ${JSON.stringify(answers)};
globalThis.fetch = async (url, init) => {
  if ((init?.method ?? "GET") !== "GET" || init?.body) throw new Error("stub: only body-less GETs");
  const u = new URL(String(url));
  const endpoint = u.pathname.split("/").pop();
  const body = endpoint === "getRatePlans"
    ? (ANSWERS.getRatePlans?.[u.searchParams.get("roomTypeID")] ?? { success: true, data: [] })
    : (ANSWERS[endpoint] ?? { success: false, message: "stub: not answered" });
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", "x-request-id": "stub" } });
};`;
  // A clean environment: no real Cloudbeds variable reaches the script (and none is printed).
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(CLOUDBEDS_|BOOKING_|STRIPE_)/.test(k)) delete env[k];
  env.CLOUDBEDS_API_KEY_BOOKING = "stub-no-network";
  env.CLOUDBEDS_PROPERTY_ID = "235064";
  const run = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(stub)}`, SCRIPT, CHECK_IN, "3"], {
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(run.status, 0, `script failed: ${run.stderr}`);
  return run.stdout;
}

function section5(out: string): string {
  const start = out.indexOf("=== 5.");
  const end = out.indexOf("=== 6.");
  assert.ok(start >= 0 && end > start, "section 5 printed");
  return out.slice(start, end);
}

const lineFor = (text: string, id: string) => text.split("\n").find((l) => l.trim().startsWith(`${id} `)) ?? "";

const detailed = (rate: number) => STAY.map((date) => ({ date, rate }));
const row = (roomTypeID: string, ratePlanNamePublic: string | null, derivedType: string | null, roomsAvailable = 1, rate = 10_000): Json => ({
  roomTypeID,
  roomRateID: `${roomTypeID}-${ratePlanNamePublic ?? "base"}`,
  roomRate: rate * STAY.length,
  roomsAvailable,
  ratePlanNamePublic,
  derivedType,
  roomRateDetailed: detailed(rate),
});

test("WI-0 section 5 counts a room type as available only on its base row (what Stripe modes sell)", () => {
  const out = runScript({
    getAvailableRoomTypes: {
      success: true,
      data: [
        {
          propertyID: "235064",
          propertyCurrency: { currencyCode: "THB" },
          propertyRooms: [
            // Honeymoon: base ("default") + Breakfast, as live on 2026-10-06.
            row("462958", "default", null),
            row("462958", "Breakfast", "fixed", 1, 12_000),
            // Garden Suite: only a derived Non-refundable row (the base plan has its own minimum stay).
            row("462961", "Non-refundable", "percentage"),
            // Sunrise: only another named, non-derived plan.
            row("462960", "Long stay", null),
            // Tuxedo 2BR: a base row without a unit left.
            row("464009", "default", null, 0),
          ],
        },
      ],
    },
    getRatePlans: {
      "462961": {
        success: true,
        data: [
          {
            rateID: "base-gs",
            ratePlanID: null,
            isDerived: false,
            ratePlanNamePublic: null,
            roomRateDetailed: STAY.map((date) => ({ date, roomsAvailable: 1, blocked: false, minLos: 4, maxLos: 0, closedToArrival: false })),
          },
          { rateID: "nr-gs", ratePlanID: "77", isDerived: true, ratePlanNamePublic: "Non-refundable", roomRateDetailed: [] },
        ],
      },
    },
  });
  const s5 = section5(out);

  assert.match(lineFor(s5, "462958"), /available 1 \(base row\)/);

  // A type returned only on a derived row is not sellable on the own page, and the base plan's rows say why.
  const garden = lineFor(s5, "462961");
  assert.doesNotMatch(garden, /available \d/);
  assert.match(garden, /only on a non-base plan \("Non-refundable" \(derived percentage\)\)/);
  assert.match(garden, /NOT sellable on the own page/);
  assert.match(garden, /cloudbeds_no_base_rate/);
  assert.match(s5, /restricted \(minLos 4 from 2027-12-05\)/);

  // Another named (non-derived) plan is not the base either.
  const sunrise = lineFor(s5, "462960");
  assert.doesNotMatch(sunrise, /available \d/);
  assert.match(sunrise, /only on a non-base plan \("Long stay"\)/);

  // A base row without a unit is not "available" (the engine skips roomsAvailable 0).
  const tuxedo = lineFor(s5, "464009");
  assert.doesNotMatch(tuxedo, /available \d/);
  assert.match(tuxedo, /base row not sellable \(roomsAvailable 0\)/);

  // A type not returned at all keeps the old verdict.
  assert.match(lineFor(s5, "462962"), /not offered -> NO RATE/);
  assert.match(out, /Nothing was written to Cloudbeds\./);
});
