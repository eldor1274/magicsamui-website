// The booking terms the guest agrees to (owner decisions of 6 Oct 2026):
// HOUSE_POLICIES is the one source of that copy, its text is pinned per terms
// version, the booking components never hard-code their own (or an old) version of it, the arrival choices keep
// their values, the terms version (POLICY_VERSION) travels with the payment
// (Stripe metadata msv_terms) into the "PAID via Stripe" Cloudbeds note - only
// when it is the version the guest's page showed (else terms_changed, before
// anything is held) - and the public pages say the same as the booking page.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { landings } from "../../data/landings.ts";
import { rooms } from "../../data/rooms.ts";
import { FREE_PICKUP_MIN_NIGHTS, HOUSE_POLICIES, POLICY_VERSION, RATE_PLANS } from "./catalogue.ts";
import { runCheckout, validationLimits } from "./checkout.ts";
import { fulfilSession } from "./fulfil.ts";
import { ARRIVAL_TIME_OPTIONS, validateGuest } from "./guest.ts";
import { keys } from "./lock.ts";
import { parseSessionMeta, sessionMetadata } from "./payments/stripe.ts";
import { GUEST, HONEYMOON, NOW, checkout, makeKit, request, serverQuote, sessionIdOf } from "./testkit.ts";
import type { Kit } from "./testkit.ts";
import type { CheckoutSuccess } from "./types.ts";
import { parseCheckoutRequest } from "./validate.ts";

const repoFile = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
const COMPONENTS = new URL("../../components/booking/", import.meta.url);
const componentSources = readdirSync(COMPONENTS, { recursive: true })
  .map(String)
  .filter((name) => /\.tsx?$/.test(name) && !name.endsWith(".test.ts"))
  .map((name) => ({ name, text: readFileSync(new URL(name.replaceAll("\\", "/"), COMPONENTS), "utf8") }));
const component = (name: string) => componentSources.find((c) => c.name.replaceAll("\\", "/") === name)!.text;

/* ------------------------------- the copy ------------------------------- */

test("HOUSE_POLICIES holds the owner's terms of 6 Oct 2026", () => {
  assert.equal(POLICY_VERSION, "2026-10-07");
  assert.deepEqual([HOUSE_POLICIES.checkInTime, HOUSE_POLICIES.checkInEndTime, HOUSE_POLICIES.checkOutTime], ["3:00 PM", "11:00 PM", "11:00 AM"]);
  assert.equal(HOUSE_POLICIES.checkIn, "Check-in 3:00 PM - 11:00 PM");
  assert.equal(HOUSE_POLICIES.arrivalHint, "Check-in is 3:00 PM - 11:00 PM. Arriving later? Message us on WhatsApp first so we can arrange it.");
  assert.match(HOUSE_POLICIES.lateArrival, /after 11:00 PM only by arrangement - message us on WhatsApp first/);
  assert.equal(
    HOUSE_POLICIES.cancellation,
    "Cancel 60 days or more before arrival: full refund. Less than 60 days before arrival: 50% of the stay is refunded. The payment processing fee is refunded only when the whole stay is refunded.",
  );
  assert.doesNotMatch(HOUSE_POLICIES.cancellation, /90 days|within 60/, "the old tiers are gone");
  assert.match(HOUSE_POLICIES.children, /aged 12 and over count as adults/);
  assert.match(HOUSE_POLICIES.children, /under 12 on request/);
  assert.match(HOUSE_POLICIES.children, /accompanied by an adult/);
  assert.match(HOUSE_POLICIES.childrenShort, /12 and over count as adults.*Under 12 on request/);
  assert.equal(FREE_PICKUP_MIN_NIGHTS, 2);
  assert.match(HOUSE_POLICIES.transfer, /Samui Airport or a nearby pier .*2 nights or more/);
  // Arrival only: "transfer" alone reads as both ways (the rate row and the summary show the title with no arrival wording).
  assert.equal(HOUSE_POLICIES.transferTitle, "Free airport or pier pickup");
  assert.match(HOUSE_POLICIES.transferHowTo, /Samui Airport or the pier/);
  assert.equal(HOUSE_POLICIES.deposit, "A damage deposit of 8,000 THB per unit is paid in cash on arrival and refunded at check-out after inspection.");
  const rules = HOUSE_POLICIES.houseRules.join("\n");
  for (const re of [
    /^No pets\.$/m,
    /^No parties\.$/m,
    /^No smoking inside \(the terrace is fine\) - 2,000 THB fee\.$/m,
    /^No toilet paper or sanitary items in the toilet - 2,000 THB fee\.$/m,
    /^Photo ID is required at check-in\.$/m,
    /^Late check-out is rarely possible: every suite is one of a kind, so there is no identical room to move the next guests to\.$/m,
    /^Cleaning is included, with fresh sheets and towels every 3 days\. Extra cleaning on request: 300 THB for a general clean, 500 THB for a full clean\.$/m,
    /lost key or access card is 500 THB; damage or missing items are charged/,
  ]) {
    assert.match(rules, re);
  }
  assert.equal(HOUSE_POLICIES.agreement, "the house rules, the deposit and the booking and cancellation policy");
  assert.equal(RATE_PLANS.standard.shortDescription, "Room only. Free airport or pier pickup on stays of 2 nights or more.");
});

// One entry per terms version. Never edit an existing entry: any change to HOUSE_POLICIES needs a new POLICY_VERSION.
const TERMS_FINGERPRINTS: Record<string, string> = {
  "2026-10-06": "d6d99e184c1121b6d66ca17b7579c5150330a74ad6851c0622f461c209c5ca1d",
  "2026-10-07": "a4f2c6ee4109ba3b69f8a6b039a6c2cffcec275c61c55d759f15238e9171a3b1",
};

test("the terms text is pinned to POLICY_VERSION: any change to HOUSE_POLICIES needs a new version", () => {
  const fingerprint = createHash("sha256").update(JSON.stringify(HOUSE_POLICIES)).digest("hex");
  assert.equal(
    fingerprint,
    TERMS_FINGERPRINTS[POLICY_VERSION],
    "booking terms text changed: bump POLICY_VERSION in catalogue.ts and add its fingerprint to TERMS_FINGERPRINTS (never rewrite an existing version's)",
  );
});

test("booking components show the terms only through HOUSE_POLICIES (no hard-coded or outdated copy)", () => {
  assert.ok(componentSources.length > 20, "found the booking components");
  const values = Object.values(HOUSE_POLICIES).flat().filter((v) => v.length > 12);
  for (const { name, text } of componentSources) {
    for (const old of [/Samui airport/i, /airport pickup/i, /3:00 PM/, /11:00 [AP]M/, /After midnight/i, /Arriving late/i, /not accommodated/, /counted as adults/, /within (60|90) days/]) {
      assert.doesNotMatch(text, old, `${name} hard-codes ${old}`);
    }
    for (const v of values) assert.equal(text.includes(v), false, `${name} copies "${v.slice(0, 40)}..." instead of using HOUSE_POLICIES`);
  }
  const guest = component("checkout/GuestDetailsStep.tsx");
  for (const use of ["hint={HOUSE_POLICIES.arrivalHint}", "I agree to {HOUSE_POLICIES.agreement}", "{HOUSE_POLICIES.deposit}", "HOUSE_POLICIES.houseRules.map", "{HOUSE_POLICIES.transfer}", "{HOUSE_POLICIES.lateArrival}"]) {
    assert.ok(guest.includes(use), `GuestDetailsStep: ${use}`);
  }
  const payment = component("checkout/PaymentStep.tsx");
  assert.ok(payment.includes("By paying you agree to {HOUSE_POLICIES.agreement}. {HOUSE_POLICIES.cancellation} {HOUSE_POLICIES.deposit}"));
  const ret = component("return/ReturnStatus.tsx");
  for (const use of ["{HOUSE_POLICIES.arrivalHint}", "{HOUSE_POLICIES.transferHowTo}", "{HOUSE_POLICIES.deposit}", "HOUSE_POLICIES.houseRules.map", "{HOUSE_POLICIES.checkInEndTime}"]) {
    assert.ok(ret.includes(use), `ReturnStatus: ${use}`);
  }
  for (const name of ["search/GuestsPopover.tsx", "results/OccupancyPopover.tsx"]) assert.ok(component(name).includes("{HOUSE_POLICIES.childrenShort}"), name);
  for (const name of ["results/ResultsList.tsx", "results/RoomDetailsModal.tsx", "results/RatePolicyModal.tsx"]) {
    assert.ok(component(name).includes("{HOUSE_POLICIES.deposit}"), `${name} shows the deposit`);
  }
  assert.ok(component("search/SearchStep.tsx").includes("HOUSE_POLICIES.transferShort"));
  assert.ok(component("summary/ReservationSummary.tsx").includes("{HOUSE_POLICIES.transferTitle} included with your stay"));
  assert.ok(component("checkout/AddonsStep.tsx").includes("HOUSE_POLICIES.transferHowTo"));
  assert.ok(component("return/ics.ts").includes("${HOUSE_POLICIES.checkIn}. ${HOUSE_POLICIES.checkOut}."));
});

test("arrival choices keep their values (saved sessions, Cloudbeds times, the late flag); 'late' now reads after 11 PM", () => {
  assert.deepEqual(
    ARRIVAL_TIME_OPTIONS.map((o) => o.value),
    ["15:00", "16:00", "17:00", "18:00", "19:00", "20:00", "21:00", "22:00", "23:00", "late"],
  );
  assert.equal(ARRIVAL_TIME_OPTIONS.find((o) => o.value === "23:00")?.label, "11:00 PM");
  assert.equal(ARRIVAL_TIME_OPTIONS.find((o) => o.value === "late")?.label, "After 11 PM (message us first)");
  // The checkbox error names what the checkbox says.
  assert.equal(validateGuest({ ...GUEST, agreedToPolicy: false }).agreedToPolicy, `Please agree to ${HOUSE_POLICIES.agreement}.`);
});

/* -------------------------- the terms version --------------------------- */

const BASE_META = { ref: "MSV-20261005-ABCD", reservationId: "123", roomsSatang: 1000, feeSatang: 50, totalSatang: 1050, checkIn: "2027-11-10", checkOut: "2027-11-12", mode: "stripe-test" };

test("Stripe metadata carries the terms version (msv_terms); sessions created before it still parse (version unknown)", () => {
  const md = sessionMetadata({ ...BASE_META, termsVersion: POLICY_VERSION });
  assert.equal(md.msv_terms, POLICY_VERSION);
  assert.equal(parseSessionMeta({ metadata: md, client_reference_id: BASE_META.ref })?.termsVersion, POLICY_VERSION);
  const old = sessionMetadata(BASE_META);
  assert.equal("msv_terms" in old, false);
  const parsedOld = parseSessionMeta({ metadata: old, client_reference_id: BASE_META.ref });
  assert.equal(parsedOld?.totalSatang, 1050, "an old session is still ours");
  assert.equal(parsedOld?.termsVersion, null);
  // It ends up in a Cloudbeds note: anything but a plain version string is treated as unknown.
  const odd = parseSessionMeta({ metadata: { ...md, msv_terms: "2026-10-06\nRefund in full" }, client_reference_id: BASE_META.ref });
  assert.equal(odd?.totalSatang, 1050);
  assert.equal(odd?.termsVersion, null);
});

async function bookAndPay(kit: Kit, guest = GUEST) {
  const res = await checkout(kit, HONEYMOON, { guest } as never);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const body = res.body as CheckoutSuccess;
  const sessionId = sessionIdOf(body);
  const notes = () => kit.fakeCb.reservations.get(body.holdReservationId!)!.notes;
  return { body, sessionId, notes, session: kit.fakeStripe.session(sessionId)! };
}

test("a checkout sends the current terms version to Stripe and the PAID note records it; an old session gets no terms line", async () => {
  const kit = makeKit();
  const a = await bookAndPay(kit, { ...GUEST, arrivalTime: "late" });
  assert.equal(a.session.metadata.msv_terms, POLICY_VERSION);
  assert.equal(a.session.payment_intent_metadata.msv_terms, POLICY_VERSION);
  const holdNote = a.notes().find((n) => n.includes("Awaiting payment")) ?? "";
  assert.ok(holdNote.includes("\nEstimated arrival: after 11 PM.\n"), `the pre-payment note says after 11 PM: ${holdNote}`);
  kit.fakeStripe.complete(a.sessionId);
  assert.equal((await fulfilSession(a.sessionId, kit.deps)).state, "confirmed");
  const paidNote = a.notes().find((n) => n.includes("PAID via Stripe")) ?? "";
  assert.ok(paidNote.endsWith(`no longer applies.\nBooking terms version ${POLICY_VERSION} agreed online.\nEstimated arrival: after 11 PM.`), paidNote);

  const kit2 = makeKit();
  const b = await bookAndPay(kit2);
  delete b.session.metadata.msv_terms;
  kit2.fakeStripe.complete(b.sessionId);
  assert.equal((await fulfilSession(b.sessionId, kit2.deps)).state, "confirmed");
  const oldNote = b.notes().find((n) => n.includes("PAID via Stripe")) ?? "";
  assert.ok(oldNote.endsWith("no longer applies."), oldNote);
});

test("the checkout body keeps only a plain terms version", () => {
  const body = request(HONEYMOON, { expectedTotalSatang: 1, expectedDueNowSatang: 1 });
  const sent = (termsVersion: unknown) => {
    const parsed = parseCheckoutRequest({ ...body, termsVersion }, validationLimits(NOW));
    assert.ok(parsed.ok, JSON.stringify(parsed));
    return parsed.ok ? parsed.value.termsVersion : "not parsed";
  };
  assert.equal(sent(POLICY_VERSION), POLICY_VERSION);
  for (const bad of [undefined, null, "", 20261006, "2026-10-06\nRefund in full", "x".repeat(33), { v: POLICY_VERSION }]) {
    assert.equal(sent(bad), undefined, JSON.stringify(bad));
  }
});

test("Pay from a page showing other terms (opened before a terms change, or no version sent) is refused before anything is held; the current page then books", async () => {
  for (const termsVersion of ["1999-01-01", undefined, "2026-10-06\nRefund in full"]) {
    const label = JSON.stringify(termsVersion) ?? "no version";
    const kit = makeKit();
    const quote = await serverQuote(kit, request(HONEYMOON));
    const stale = { ...request(HONEYMOON, { termsVersion }), expectedTotalSatang: quote.totalSatang, expectedDueNowSatang: quote.dueNowSatang };
    const res = await runCheckout(stale, kit.checkoutDeps());
    assert.equal(res.status, 409, label);
    assert.equal(res.body.ok ? "" : res.body.error, "terms_changed", label);
    assert.match(res.body.ok ? "" : res.body.message, /terms were just updated\. Nothing has been reserved or charged - please refresh the page/, label);
    assert.equal(kit.fakeCb.count("postReservation"), 0, `${label}: no hold`);
    assert.deepEqual(kit.fakeCb.calls.filter((c) => c.verb !== "GET"), [], `${label}: no Cloudbeds write`);
    assert.equal(kit.fakeStripe.calls.filter((c) => c.method === "POST").length, 0, `${label}: no Stripe session`);
    assert.deepEqual(await kit.deps.kv.zrangeByScore(keys.holdIndex(), 0, Number.MAX_SAFE_INTEGER, 10), [], `${label}: no hold record`);
    assert.deepEqual(await kit.deps.kv.zrangeByScore(keys.intentIndex(), 0, Number.MAX_SAFE_INTEGER, 10), [], `${label}: no hold intent`);

    // Refreshed and ticked again: the page sends the version it now shows, and that is what is recorded.
    const a = await bookAndPay(kit);
    assert.equal(a.session.metadata.msv_terms, POLICY_VERSION, label);
    kit.fakeStripe.complete(a.sessionId);
    assert.equal((await fulfilSession(a.sessionId, kit.deps)).state, "confirmed");
    assert.ok((a.notes().find((n) => n.includes("PAID via Stripe")) ?? "").includes(`\nBooking terms version ${POLICY_VERSION} agreed online.`), label);
  }
});

test("booking page: Pay sends the terms version it shows; terms_changed clears the tick and offers a refresh; a saved tick counts only for the same terms", () => {
  const app = component("BookingApp.tsx");
  assert.match(app, /import \{ POLICY_VERSION, [^}]*\} from "@\/lib\/booking\/catalogue";/);
  assert.match(app, /postCheckout\(\{[\s\S]*?termsVersion: POLICY_VERSION,[\s\S]*?\}\);/, "sent with the checkout body");
  const state = component("state.ts");
  assert.match(
    state,
    /if \(error\.code === "terms_changed"\) \{[\s\S]{0,400}?return \{ \.\.\.state, guest: \{ \.\.\.state\.guest, agreedToPolicy: false \}, checkout: \{ status: "error", error \} \};/,
    "the reducer clears the tick",
  );
  assert.match(state, /termsVersion: POLICY_VERSION,\s*savedAt:/, "the saved booking records the version it was ticked for");
  assert.match(state, /guest: sanitizeGuest\(p\.guest, p\.termsVersion === POLICY_VERSION\)/, "a saved tick for other terms is dropped");
  assert.match(state, /out\.agreedToPolicy = termsCurrent && v === true;/);
  const payment = component("checkout/PaymentStep.tsx");
  assert.match(payment, /case "terms_changed":[\s\S]{0,600}?onClick=\{\(\) => window\.location\.reload\(\)\}[\s\S]{0,200}?Refresh page/, "a Refresh page action");
});

/* ------------------------------ the runbook ------------------------------ */

test("runbook: Cloudbeds' confirmation email replaces the terms on the paid return page, so CLOUDBEDS_SEND_STATUS_EMAIL stays off until its terms match HOUSE_POLICIES", () => {
  // The paid return page lists the agreed terms only while Cloudbeds sends no confirmation email.
  const ret = component("return/ReturnStatus.tsx");
  assert.match(ret, /const pageIsConfirmation = stripe && !sendsConfirmationEmail;/);
  assert.match(ret, /\{pageIsConfirmation && <BookingTerms /);
  const runbook = repoFile("docs/booking-engine.md");
  const case12 = runbook.match(/^12\. \*\*Confirmation email\.\*\*.*$/m)?.[0] ?? "";
  assert.match(case12, /Keep it `true` only if \*\*both\*\* hold: \(a\) that email is a proper booking confirmation, and \(b\) its terms match/);
  for (const term of ["check-in until 11:00 PM", "children", "house rules", "8,000 THB deposit", "60 days or more: full refund"]) {
    assert.ok(case12.includes(term), `case 12 compares: ${term}`);
  }
  assert.match(case12, /Otherwise set it back to `false`/);
  const goNoGo = runbook.match(/^\*\*Go\/no-go:\*\*.*$/m)?.[0] ?? "";
  assert.match(goNoGo, /`CLOUDBEDS_SEND_STATUS_EMAIL` stays off/);
});

/* ---------------------------- public pages ----------------------------- */

test("public room pages: check-in 15:00-23:00 (later by arrangement), children under 12 on request with an adult, smoking not inside (terrace fine), one free-transfer wording (airport or pier, 2+ nights)", () => {
  const transferLines = new Set<string>();
  for (const room of rooms) {
    assert.equal(room.importantInfo.checkIn, "15:00-23:00 (later by arrangement)", room.slug);
    assert.equal(room.importantInfo.children, "Under 12 on request, with an adult", room.slug);
    assert.equal(room.importantInfo.smoking, "Not inside (terrace is fine) - 2,000 THB fee", room.slug);
    for (const line of [...room.amenities, ...(room.guestAccess ?? []), ...(room.notes ?? [])]) {
      if (/transfer|shuttle|pick ?up/i.test(line)) transferLines.add(line);
    }
  }
  assert.deepEqual([...transferLines].sort(), [
    "Free transfer from Samui Airport or a nearby pier (2+ nights)",
    "Free transfer on arrival from Samui Airport or a nearby pier (such as Bangrak Pier) for stays of 2 nights or more.",
    "Paid airport transfer for 1-night stays",
  ]);
});

test("homepage, language pages and llms.txt: the transfer covers the airport or a nearby pier; arrival perks are not about check-in; llms.txt smoking matches the terms", () => {
  assert.match(repoFile("src/app/page.tsx"), /Complimentary transfer from Samui Airport or a nearby pier on stays of 2\+ nights\./);
  const pier: Record<string, RegExp> = { he: /מזח/, ru: /пирс/, fr: /embarcadère/, de: /Pier/, zh: /码头/, es: /muelle/, th: /ท่าเรือ/ };
  assert.deepEqual(Object.keys(landings).sort(), Object.keys(pier).sort());
  for (const [code, t] of Object.entries(landings)) {
    const transfer = t.perks[1];
    assert.match(`${transfer.title} ${transfer.text}`, pier[code], `${code}: pier`);
    assert.match(transfer.text, /2|שני לילות/, `${code}: 2+ nights`);
  }
  // Arrival only (decision 4): never a word that promises a ride back too (zh 接送, th รับส่ง = pick-up AND drop-off).
  assert.doesNotMatch(`${landings.zh.perks[1].title} ${landings.zh.perks[1].text}`, /接送/, "zh: arrival only");
  assert.doesNotMatch(`${landings.th.perks[1].title} ${landings.th.perks[1].text}`, /รับส่ง/, "th: arrival only");
  assert.equal(landings.ru.perks[3].title, "Гибкое прибытие");
  assert.equal(landings.th.perks[3].title, "การมาถึงที่ยืดหยุ่น");
  const llms = repoFile("public/llms.txt");
  assert.match(llms, /Check-in 15:00–23:00 \(later arrivals only by arrangement on WhatsApp\)/);
  assert.match(llms, /free transfer from Samui Airport or a nearby pier\s+on stays of 2\+ nights/);
  assert.match(llms, /children under 12 on request/);
  assert.match(llms, /Damage deposit 8,000 THB per unit, paid in cash on arrival,\s+refunded at\s+check-out after inspection/);
  assert.match(llms, /No pets; no smoking inside \(the terrace is fine; 2,000 THB fee\)/);
  assert.doesNotMatch(llms, /children 12\+ welcome|free airport pickup|balconies only/i);
});
