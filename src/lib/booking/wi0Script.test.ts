// The read-only WI-0 owner script (scripts/cloudbeds-wi0-check.mjs), run as a
// child process with `fetch` replaced by an in-memory stub: nothing leaves
// this machine and no key is needed. Only the verdicts the runbook relies on
// are checked here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveCloudbedsPaymentMethod } from "./config.ts";

const SCRIPT = fileURLToPath(new URL("../../../scripts/cloudbeds-wi0-check.mjs", import.meta.url));
const CHECK_IN = "2027-12-05";
const STAY = ["2027-12-05", "2027-12-06", "2027-12-07"];

type Json = Record<string, unknown>;

/** Runs the script with every Cloudbeds call answered from `answers` (by endpoint; getRatePlans by roomTypeID). */
function runScript(
  answers: { getAvailableRoomTypes: Json; getRatePlans?: Record<string, Json>; getSources?: Json; getPaymentMethods?: Json },
  extraEnv: Record<string, string> = {},
): string {
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
  Object.assign(env, extraEnv);
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

test("WI-0 section 4b reads getSources rows nested inside data, as live on 2026-10-06", () => {
  const fee = { name: "Card Charging Fee", amount: "5.00000", amountType: "percentage", type: "exclusive" };
  const out = runScript(
    {
      getAvailableRoomTypes: {
        success: true,
        data: [{ propertyID: "235064", propertyCurrency: { currencyCode: "THB" }, propertyRooms: [row("462958", "default", null)] }],
      },
      // Live shape: the source rows sit in an array inside `data`.
      getSources: {
        success: true,
        data: [
          [
            { sourceID: "s-1", sourceName: "Website/Booking Engine", isThirdParty: false, status: true, taxes: [], fees: [fee] },
            { sourceID: "s-1192402", sourceName: "magicsamui.com own booking page", isThirdParty: false, status: true, taxes: [], fees: [] },
            { sourceID: "ss-644910-1", sourceName: "Booking.com (Hotel Collect Booking)", isThirdParty: true, status: true, taxes: [], fees: [fee] },
          ],
        ],
      },
    },
    { CLOUDBEDS_SOURCE_ID: "s-1192402" },
  );
  const start = out.indexOf("=== 4b.");
  const s4b = out.slice(start, out.indexOf("=== 4c.", start));

  assert.match(s4b, /"Website\/Booking Engine" \(s-1\): API holds without sourceID get this source/);
  assert.match(s4b, /exclusive % on it = 5%/);
  assert.match(s4b, /"magicsamui\.com own booking page" \(s-1192402\): candidate for CLOUDBEDS_SOURCE_ID/);
  assert.match(s4b, /CLOUDBEDS_SOURCE_ID="s-1192402": "magicsamui\.com own booking page" \(s-1192402\) active; exclusive % = 0%/);
  assert.doesNotMatch(s4b, /sourceID=null/);
  assert.doesNotMatch(s4b, /NOT FOUND/);
});

/* ---------------- section 6b: the custom 'Beam(website)' payment method (design S6.1) ---------------- */

const ONE_ROOM: Json = {
  success: true,
  data: [{ propertyID: "235064", propertyCurrency: { currencyCode: "THB" }, propertyRooms: [row("462958", "default", null)] }],
};

/** getPaymentMethods as the property lists them (live 2026-10-06, shortened), plus `extra` rows. */
function paymentMethods(extra: Json[] = []): Json {
  const m = (method: string, code: string, name: string) => ({ method, code, name });
  return {
    success: true,
    data: {
      methods: [
        m("credit", "cards", "Credit Card"),
        m("bank_transfer", "ebanking", "Bank Transfer"),
        m("cash", "cash", "Cash"),
        m("Stripe(website)", "Stripe(website)", "Stripe (website)"),
        ...extra,
      ],
      gateway: { name: "StripeConnectGateway", currency: "THB" },
    },
  };
}

const BEAM_ROW: Json = { method: "Beam(website)", code: "Beam(website)", name: "Beam (website)" };

function section6b(out: string): string {
  const start = out.indexOf("=== 6b.");
  const end = out.indexOf("=== 7.");
  assert.ok(start >= 0 && end > start, "section 6b printed");
  return out.slice(start, end);
}

/** The line a method variable's verdict is printed on. */
const verdictOf = (text: string, name: string) => text.split("\n").find((l) => l.trim().startsWith(`${name}=`) || l.trim().startsWith(`${name}:`)) ?? "";

test("WI-0 section 6b finds the custom Beam method and prints its exact method value; the Beam variables get the engine's verdicts", () => {
  const out = runScript(
    { getAvailableRoomTypes: ONE_ROOM, getPaymentMethods: paymentMethods([BEAM_ROW]) },
    { CLOUDBEDS_STRIPE_PAYMENT_METHOD: "Stripe(website)", CLOUDBEDS_BEAM_PAYMENT_METHOD: "Beam(website)", CLOUDBEDS_BEAM_TEST_PAYMENT_METHOD: " " },
  );
  const s6b = section6b(out);
  assert.match(s6b, /Beam\(website\) \| Beam\(website\) \| Beam \(website\)/);
  assert.match(s6b, /-> custom Beam method found: method value "Beam\(website\)" - copy it EXACTLY into CLOUDBEDS_BEAM_PAYMENT_METHOD/);
  assert.match(verdictOf(s6b, "CLOUDBEDS_BEAM_PAYMENT_METHOD"), /^ *CLOUDBEDS_BEAM_PAYMENT_METHOD="Beam\(website\)": EXACT \(Beam\(website\) \| Beam\(website\) \| Beam \(website\)\)$/);
  // An empty (or blank) TEST variable is not set: the engine records Beam test money under the live variable's method.
  assert.match(verdictOf(s6b, "CLOUDBEDS_BEAM_TEST_PAYMENT_METHOD"), /: empty, so the engine uses CLOUDBEDS_BEAM_PAYMENT_METHOD\.$/);
  // Section 6 (Stripe) reads as before.
  const s6 = out.slice(out.indexOf("=== 6."), out.indexOf("=== 6b."));
  assert.match(s6, /CLOUDBEDS_STRIPE_PAYMENT_METHOD="Stripe\(website\)": EXACT \(Stripe\(website\) \| Stripe\(website\) \| Stripe \(website\)\)/);
  assert.match(s6, /CLOUDBEDS_STRIPE_TEST_PAYMENT_METHOD: not set in this shell/);
  assert.doesNotMatch(s6, /CLOUDBEDS_BEAM/);
  assert.match(out, /Nothing was written to Cloudbeds\./);
});

test("WI-0 section 6b keeps the exact case, refuses built-in methods and the Stripe method (naming the Stripe variable), and names a Stripe row", () => {
  const out = runScript(
    { getAvailableRoomTypes: ONE_ROOM, getPaymentMethods: paymentMethods([BEAM_ROW]) },
    {
      CLOUDBEDS_STRIPE_PAYMENT_METHOD: "Stripe(website)",
      CLOUDBEDS_BEAM_PAYMENT_METHOD: "beam(website)",
      CLOUDBEDS_BEAM_TEST_PAYMENT_METHOD: "CASH",
    },
  );
  const s6b = section6b(out);
  assert.match(verdictOf(s6b, "CLOUDBEDS_BEAM_PAYMENT_METHOD"), /: NEAR, not exact - candidates: Beam\(website\) \| Beam\(website\) \| Beam \(website\) \(copy the exact method value\)$/);
  assert.match(
    verdictOf(s6b, "CLOUDBEDS_BEAM_TEST_PAYMENT_METHOD"),
    /: BUILT-IN NOT ALLOWED \("CASH" is a Cloudbeds built-in method; use the custom 'Beam\(website\)' method\)$/,
  );

  const clash = section6b(
    runScript(
      { getAvailableRoomTypes: ONE_ROOM, getPaymentMethods: paymentMethods([BEAM_ROW]) },
      {
        CLOUDBEDS_STRIPE_PAYMENT_METHOD: "Stripe(website)",
        CLOUDBEDS_STRIPE_TEST_PAYMENT_METHOD: "StripeTest(website)",
        CLOUDBEDS_BEAM_PAYMENT_METHOD: "STRIPE(WEBSITE)",
        CLOUDBEDS_BEAM_TEST_PAYMENT_METHOD: " stripetest(website) ",
      },
    ),
  );
  assert.match(
    verdictOf(clash, "CLOUDBEDS_BEAM_PAYMENT_METHOD"),
    /: STRIPE METHOD NOT ALLOWED \("STRIPE\(WEBSITE\)" is the Stripe method in CLOUDBEDS_STRIPE_PAYMENT_METHOD; Beam money must be recorded under the custom 'Beam\(website\)' method\)$/,
  );
  assert.match(verdictOf(clash, "CLOUDBEDS_BEAM_TEST_PAYMENT_METHOD"), /: STRIPE METHOD NOT ALLOWED \("stripetest\(website\)" is the Stripe method in CLOUDBEDS_STRIPE_TEST_PAYMENT_METHOD;/);

  // Without the Stripe variables in the shell the engine can't tell, but the script still names Cloudbeds' Stripe row.
  const noVars = section6b(runScript({ getAvailableRoomTypes: ONE_ROOM, getPaymentMethods: paymentMethods([BEAM_ROW]) }, { CLOUDBEDS_BEAM_PAYMENT_METHOD: "Stripe(website)" }));
  assert.match(
    verdictOf(noVars, "CLOUDBEDS_BEAM_PAYMENT_METHOD"),
    /: EXACT \(Stripe\(website\) \| Stripe\(website\) \| Stripe \(website\)\) {2}<- that is a Stripe method of Cloudbeds' list: Beam money belongs under the custom Beam method$/,
  );
  assert.match(verdictOf(noVars, "CLOUDBEDS_BEAM_TEST_PAYMENT_METHOD"), /CLOUDBEDS_BEAM_TEST_PAYMENT_METHOD: not set in this shell/);
});

test("WI-0 section 6b says when Cloudbeds has no custom Beam method, and prints a Beam method's value whatever Cloudbeds assigned", () => {
  // A built-in method whose display name mentions Beam is never the custom method (Beam money can't go there).
  const none = section6b(
    runScript({ getAvailableRoomTypes: ONE_ROOM, getPaymentMethods: paymentMethods([{ method: "pay_pal", code: "pay_pal", name: "PayPal (not Beam)" }]) }),
  );
  assert.doesNotMatch(none, /pay_pal/);
  assert.match(none, /-> NO custom Beam method in Cloudbeds\. Create it \(Account > Settings > Finance > Additional and Custom Payment Methods > \+ Add Payment Type, name Beam\(website\)\)/);
  assert.doesNotMatch(none, /custom Beam method found/);

  // Cloudbeds assigns the value (the property's "With Cash On Arrival" got 1): the name finds it, the value is printed as is.
  const numbered = section6b(
    runScript(
      { getAvailableRoomTypes: ONE_ROOM, getPaymentMethods: paymentMethods([{ method: "7", code: "7", name: "Beam(website)" }]) },
      { CLOUDBEDS_BEAM_PAYMENT_METHOD: "7" },
    ),
  );
  assert.match(numbered, /-> custom Beam method found: method value "7" - copy it EXACTLY into CLOUDBEDS_BEAM_PAYMENT_METHOD/);
  assert.match(verdictOf(numbered, "CLOUDBEDS_BEAM_PAYMENT_METHOD"), /: EXACT \(7 \| 7 \| Beam\(website\)\)$/);

  // A live and a separate test method: both printed, and which variable takes which.
  const two = section6b(
    runScript({ getAvailableRoomTypes: ONE_ROOM, getPaymentMethods: paymentMethods([BEAM_ROW, { method: "BeamTest(website)", code: "BeamTest(website)", name: "BeamTest (website)" }]) }),
  );
  assert.match(two, /-> custom Beam method found: method value "Beam\(website\)"\n/);
  assert.match(two, /-> custom Beam method found: method value "BeamTest\(website\)"\n/);
  assert.match(two, /-> more than one method mentions Beam: copy the website's Beam method's value EXACTLY into CLOUDBEDS_BEAM_PAYMENT_METHOD, and a separate test method's \(if any\) into CLOUDBEDS_BEAM_TEST_PAYMENT_METHOD\./);

  // getPaymentMethods not answered (e.g. a key without read:payment): nothing to look in.
  const refused = section6b(runScript({ getAvailableRoomTypes: ONE_ROOM }));
  assert.match(refused, /not checked: getPaymentMethods failed \(see section 6\)\./);
});

test("WI-0 section 6b refuses exactly the Beam method values config.ts refuses (the payment-method-config problem)", () => {
  const stripeVars = { CLOUDBEDS_STRIPE_PAYMENT_METHOD: "Stripe(website)", CLOUDBEDS_STRIPE_TEST_PAYMENT_METHOD: "StripeTest(website)" };
  const values = [
    "Beam(website)",
    "beam(website)",
    "Beam (website)",
    "cash",
    "Bank_Transfer",
    "stripe(website)",
    "STRIPETEST(website)",
    `B${"e".repeat(64)}`,
    "Beam​(website)",
    "BeamTest(website)",
  ];
  const refusedVerdict = /: (INVALID FOR THE ENGINE|BUILT-IN NOT ALLOWED|STRIPE METHOD NOT ALLOWED) /;
  for (let i = 0; i < values.length; i += 2) {
    const [live, testValue] = [values[i], values[i + 1]];
    const env = { ...stripeVars, CLOUDBEDS_BEAM_PAYMENT_METHOD: live, CLOUDBEDS_BEAM_TEST_PAYMENT_METHOD: testValue };
    const s6b = section6b(runScript({ getAvailableRoomTypes: ONE_ROOM, getPaymentMethods: paymentMethods([BEAM_ROW]) }, env));
    // beam-live reads only the live variable; beam-playground reads the TEST one while it is set.
    const liveProblem = resolveCloudbedsPaymentMethod(env, "beam-live").problem;
    const testProblem = resolveCloudbedsPaymentMethod(env, "beam-playground").problem;
    assert.equal(refusedVerdict.test(verdictOf(s6b, "CLOUDBEDS_BEAM_PAYMENT_METHOD")), liveProblem !== null, `live ${JSON.stringify(live)}: ${liveProblem}`);
    assert.equal(refusedVerdict.test(verdictOf(s6b, "CLOUDBEDS_BEAM_TEST_PAYMENT_METHOD")), testProblem !== null, `test ${JSON.stringify(testValue)}: ${testProblem}`);
    // A refusal that names the Stripe method names the same variable as the engine's problem text.
    for (const [name, problem] of [
      ["CLOUDBEDS_BEAM_PAYMENT_METHOD", liveProblem],
      ["CLOUDBEDS_BEAM_TEST_PAYMENT_METHOD", testProblem],
    ] as const) {
      const clash = /is the Stripe method in (CLOUDBEDS_STRIPE_\w+)/.exec(verdictOf(s6b, name))?.[1];
      if (clash) assert.ok(problem?.includes(`is the Stripe method (${clash})`), `${name}: ${problem}`);
    }
  }
});
