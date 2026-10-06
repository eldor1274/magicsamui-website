# Own booking engine: Stripe checkout, Cloudbeds as master

This is the runbook for the direct booking engine on magicsamui.com: how it works, how to switch it on, how to test it, and what to do when something goes wrong. The older Beam preview notes are in `docs/booking-beam-preview.md`.

**Short version**
- With **no new environment variables**, nothing changes. `/booking` shows the Cloudbeds engine as today, and `/booking-preview` stays a noindex demo (locally and on preview deployments; on the **production** deployment it shows "Payments locked" until `BOOKING_TOKEN_SECRET` is set, because the public demo secret is never accepted there).
- Cloudbeds stays the master for availability, prices, closures and OTA sync. Eldor keeps managing rooms and prices in Cloudbeds.
- Stripe only moves money. It is the owner's existing Thai Stripe account, the one already connected to Cloudbeds.
- The guest pays 100% up front, plus an openly shown "Payment processing fee": 5% on Stripe, 3% on Beam.

---

## 1. Architecture

### Providers and modes

`BOOKING_PAYMENT_PROVIDER` chooses the provider. The provider and its keys then give the payment mode.

| Mode | When | Money | Cloudbeds reservation |
|---|---|---|---|
| `demo` | Default (no env), or `BOOKING_PAYMENT_PROVIDER=demo` | Simulated | None |
| `beam-playground` | `provider=beam` (or legacy `BEAM_API_BASE`) with playground keys | Beam test money | None. Preview only. |
| `beam-live` | **Always locked in code** (`LIVE_FULFILMENT_READY.beam=false`) | – | – |
| `stripe-mock` | `provider=stripe`, `BOOKING_STRIPE_MOCK=true`, no key. Never on production. | In-repo fake Stripe (MOCK) | In-repo fake Cloudbeds (MOCK) |
| `stripe-test` | `provider=stripe` and a `sk_test_`/`rk_test_` key | Stripe test cards only | **Real** with `CLOUDBEDS_API_KEY_BOOKING` (guarded, see below). Mocked without it. |
| `stripe-live` | `provider=stripe`, a `sk_live_`/`rk_live_` key, and **every** live condition | Real cards | Real |

**Live conditions.** All of these must hold, or the config throws `live_payments_locked`. Then nothing is charged, the page shows a locked message with the WhatsApp link, and the server log lists what is missing.
- `BOOKING_PAYMENT_PROVIDER=stripe`
- A live key
- `BOOKING_ALLOW_LIVE_PAYMENTS=true`
- `VERCEL_ENV=production`
- `CLOUDBEDS_API_KEY_BOOKING` and a numeric `CLOUDBEDS_PROPERTY_ID`
- `STRIPE_WEBHOOK_SECRET` (`whsec_…`)
- `BOOKING_SWEEP_SECRET` (or Vercel's `CRON_SECRET`), 16+ characters: the sweeper is the only recovery for lost holds once Stripe stops retrying
- Upstash Redis
- A strong `BOOKING_TOKEN_SECRET`
- Live Cloudbeds data, with `BOOKING_DATA_SOURCE` not set to `demo`
- `BOOKING_STRIPE_MOCK` not set to `true`
- `LIVE_FULFILMENT_READY.stripe` (true in code)

The full matrix is tested in `src/lib/booking/stripeConfig.test.ts`.

### Booking flow (hold first)

```
Guest            Our server (Next.js on Vercel)                     Cloudbeds (master)           Stripe
-----            ------------------------------                     ------------------           ------
search  ───────► /api/booking/availability ───────────────────────► getAvailableRoomTypes (60 s cache)
Pay     ───────► /api/booking/checkout
                  1 validate cart + guest (server side)
                  2 re-quote, NO cache ───────────────────────────► getAvailableRoomTypes
                  3 test-mode guard (stripe-test + real writes: staff cookie + test email + 12 months)
                  4 Stripe maximum charge (THB 999,999.99) checked; open-holds brake (max 8 open holds)
                  5 hold INTENT recorded in Redis (before any Cloudbeds write)
                  6 LOCK every physical unit in the cart (Redis SET NX, sorted; combos share units)
                  7   refuse a cart overlapping one of OUR open holds (units + dates in Redis)
                      per-guest brake (5 holds per IP+email, 15 per IP, per 40 min)
                      restrictions, fresh ─────────────────────────► getRatePlans (minLos, CTA/CTD, blocked, roomsAvailable)
                  8   availability, fresh ─────────────────────────► getAvailableRoomTypes (no cache)
                  9   HOLD (only with 17+ s of the 25 s budget left) ► postReservation (roomTypeID + roomRateID,
                                                                     guest, thirdPartyIdentifier=MSV ref
                                                                     (+ "-TEST" outside live),
                                                                     sendEmailConfirmation=false)
                                                                     → unit leaves Booking.com/Airbnb
                     hold recorded (units + dates) in the open-holds index; UNLOCK; intent settled
                 10 assert grandTotal == room subtotal, else cancel + price_changed
                    (no readable total: read back once with getReservation, else cancel at once)
                 11 putReservation status=not_confirmed + note (best effort; skipped when out of time)
                 12 Checkout Session ───────────────────────────────────────────────────────────────► create (THB satang,
                    (timeout sized to the time left; cancel the hold if it can't fit)               card+promptpay, 30 min,
                                                                                                    Adaptive Pricing off)
                    (any failure after this: expire the session + cancel the hold)
redirect ◄────── checkout.stripe.com
pays    ────────────────────────────────────────────────────────────────────────────────────────────► webhook
                 /api/stripe/webhook (signature over raw body) ◄────────────────────────────────────── completed / async_*
                  fulfil() under lock:
                   re-read session, mark "paid" ──────────────────► postCustomItem (fee, referenceID dedupe; optional,
                                                                      retried after confirm, alert if missing)
                                                                    postPayment (type "stripe", baht, Stripe ids)
                                                                    putReservation status=confirmed
return  ───────► /booking-preview/return (or /booking/return) → status → fulfil() again (idempotent)
not paid        expired / async_payment_failed / guest Cancel ────► putReservation status=canceled
sweeper ───────► /api/booking/sweep every ~10 min: repairs dropped webhooks, releases stale holds,
                 re-sends undelivered critical alerts; 502 when its Cloudbeds side failed
```

### Guarantees

- **Hold before charge.** We never charge for a room we don't hold. Inventory is only ever decremented in Cloudbeds, the system that feeds the OTAs.
- **Our own checkouts never race each other.** The fresh restriction + availability check and `postReservation` run under a Redis lock per **physical unit** (HM, SR, GS, SVL, TUX, TUXL; a combination type locks all its units). The hold record - with its units and dates - is written **before** the lock is released, and every checkout refuses a cart that overlaps one of our open holds. So our own serialisation does not depend on how fast Cloudbeds' `getAvailableRoomTypes` reflects a new reservation, including combination types built from shared units (tested with a fake whose availability lags and would overbook). Only the race against an OTA booking remains, as with the Cloudbeds engine - and Stage B tests 11 and 14 check that Cloudbeds refuses it and that pending holds block inventory.
- **No lost holds.** A hold *intent* is written to Redis **before** `postReservation`. If the answer never arrives (timeout, 5xx, a success without an id, the function killed mid-call), the intent stays open, the owner gets an alert, and the sweeper finds the reservation by its `thirdPartyIdentifier` and releases it once it is 40+ minutes old - whether Cloudbeds created it as `not_confirmed` or `confirmed`. A matched orphan becomes a hold record carrying the **intent's** time, so a release that fails is retried by every later run on that age (and alerted at once). An intent never matched is dropped after 12 hours **with an alert** naming the third-party id to check by hand. A success with a valid id but no readable total is cancelled at once.
- **The sweeper checks ages itself.** It only releases a hold it can prove is older than 40 minutes: our own record's time, the intent's time, or - only for a reservation we have no record or intent of - Cloudbeds' creation time read cautiously (the v1.3 `getReservations` has only the property-local `dateCreated`, read as UTC: never older than it is, up to 7 hours younger). It never relies on how Cloudbeds interprets the `resultsFrom`/`resultsTo` window.
- **The sweeper fails loudly.** A run whose Cloudbeds listing fails is not recorded as a sweep (so checkout's "sweeper has not run" alert fires), answers HTTP 502 (the cron's `curl -f` fails), counts unresolved intents in `openHolds`, and alerts after 3 such runs in a row.
- **The 30 s function limit.** The checkout route answers within 25 s: it refuses to start a hold with less than 17 s left, skips the best-effort pending mark and note when short of time, sizes the Stripe call (timeout, retries) to what is left, and gives the hold back with a 503 if the Stripe call can't fit. Every Cloudbeds write on the checkout path is bound to the same deadline (`CloudbedsWriter.bounded`): the wait for a rate-limit token, the request timeout and any 429 retry are cut to the time left, and a call with under 1.5 s left is not sent at all. So `postReservation` can never still be running when the platform stops the function; if its answer is cut short, the "outcome unknown" alert is sent and the sweeper releases the hold by its intent.
- **Test and live never touch each other's holds.** Outside live the `thirdPartyIdentifier` is `MSV-…-TEST`; each sweeper only touches its own mode's holds and records. Stage B and live may share one Redis: hold and intent records carry their mode, and every key that is not tied to one record - alert repeat claims, stored critical alerts, the last successful sweep, the failure counters and the paid-but-unconfirmed list - is kept per mode (`msv:live:…` vs `msv:stripe-test:…`), so a test deployment can never hide a dead live sweeper or re-send, clear or suppress a live alert.
- **A paid booking is never left behind.** As soon as fulfil sees a session paid it sets the paid marker, lists the session as paid-but-unconfirmed and adds a reservation note in Cloudbeds: "PAID via Stripe pi_… - do NOT cancel". The hold stays in the sweeper's index until fulfil's done marker exists, and the sweeper retries every paid-but-unconfirmed session on every run with no time limit (beyond the 48 h Stripe lookback and Stripe's 3 days of webhook retries). The failure alert names the booking (ref, Cloudbeds reservation, amount); after 2 hours unconfirmed it becomes the CRITICAL "URGENT: paid booking … still not confirmed" (stored and re-sent until delivered).
- **Fulfil never undoes staff work.** It confirms only a reservation that is still "Confirmation pending"; one staff already confirmed, checked in or checked out is left as it is, and any other status goes to the owner (`needs_attention`).
- **Only the Standard Rate is sold.** In Stripe modes availability uses Cloudbeds' base (BAR) row only. A room type that comes back with only a derived or named plan (package, long stay, non-refundable) is shown as unavailable (log `cloudbeds_no_base_rate`) instead of being sold as that plan under the "Standard Rate - Room only" label.
- **Staff stay in charge.** A hold we had marked "Confirmation pending" that staff later confirmed by hand (no payment recorded) is never cancelled automatically: the owner is alerted instead. Checked-in / checked-out / no-show reservations are never cancelled. A **confirmed** reservation carrying an `MSV-` id that we have no record or intent of (e.g. staff re-booked a paid guest under the ref, or Redis lost the record) is never cancelled either: the owner is told once.
- **Never cancel a paid booking.** Release is refused when:
  - Stripe says the session is paid, open or processing;
  - our "paid" marker exists (set before any payment write);
  - the Cloudbeds folio already shows a payment.
- **Fulfil is idempotent.** It uses:
  - a Redis `SET NX EX 120` lock per session, so 5 concurrent calls produce exactly one `postPayment` (tested);
  - per-step markers (fee, payment);
  - a check of the folio's paid amount before `postPayment` (`balanceDetailed` read as an object **or** an array, as v1.3 allows; an unreadable paid figure is "unknown", never 0);
  - a payment-**attempt** claim written before `postPayment` is sent: if its answer is lost (timeout/5xx), retries do not post again for 10 minutes while the folio catches up; after that, a folio still showing no payment gets one more post, and a folio whose paid amount can't be read goes to the owner (`needs_attention`) instead of a guess (tested with a fake that commits the payment after the retry read the folio);
  - a 30-day done marker.
- **The fee line never blocks a confirmation.** `postCustomItem` is tried first (so the folio balances), but if it fails the payment is still recorded and the reservation confirmed; the fee is retried once after confirming and, if still missing, the owner gets "the processing fee line is missing" to add it by hand.
- **Test money is labelled.** Outside live, the payment description and the reservation notes in Cloudbeds start with `TEST MODE - NOT REAL MONEY`. Set `CLOUDBEDS_STRIPE_TEST_PAYMENT_METHOD` to a separate Cloudbeds method (e.g. "Stripe TEST") to keep test money out of the real "Stripe" method's reports.
- **The fee line has one Cloudbeds item per mode.** Cloudbeds keeps the name and description sent the first time an `appItemID` is used and ignores them on later calls. So live uses `msv-payment-processing-fee` ("Payment processing fee") and every other mode `msv-payment-processing-fee-test` ("TEST - Payment processing fee"), and the item's note is static - no ref, no PaymentIntent. The per-booking ids are in the payment's description and in the "PAID via Stripe" reservation note. Test and live fees are therefore separate items in Cloudbeds' reports, and a Stage B test line can never label a live one.
- **Money units.** Satang (integers) everywhere in our code and in Stripe (THB is a 2-decimal currency). Conversion to baht happens **only** at the Cloudbeds boundary (`satangToBahtString`, `cloudbedsMoneyToSatang`).
- **No personal data** in URLs, tokens, logs, Stripe metadata or analytics. The guest's details go only to Cloudbeds (the reservation) and Stripe (`customer_email`, and `payment_intent_data.receipt_email` so Stripe sends the live receipt whatever the account's email settings are). Cloudbeds error messages are redacted before logging. The paid return page - where `purchase` fires - never prints the guest's email address ("to the email address you entered"), so no Google tag can pick it up from the page.
- **Analytics.** `purchase` fires once, only in `stripe-live` on the production deployment, after the server reports paid **and** Cloudbeds confirmed. `transaction_id` is the Cloudbeds reservationID and `value` is in baht. The status API returns `purchase` only then. On `/booking-preview*` gtag.js is loaded **only while the deployment takes real payments** (stripe-live on production: Stage C and the soft launch run there, so their real purchases reach GA4 and the Google Ads import), and on `/booking-preview/return` also while live Stripe payments are only being **finished** (emergency stop, provider drain), so the purchases of bookings already paid are still recorded. In demo, MOCK, test mode and Stage B it never loads, so not even the layout's queued `page_view` is sent. Clarity never records `/booking-preview*` (privacy). `purchase` also needs `NEXT_PUBLIC_VERCEL_ENV=production` in the browser bundle (see section 2). The address-bar cleanup on `/booking` keeps the ad-click ids Google, Microsoft and Meta use for attribution (`gclid`, `gbraid`, `wbraid`, `gad_source`, `gad_campaignid`, `dclid`, `_gl`, `msclkid`, `fbclid`, `utm_*`) and drops everything else.
- **The fee is shown with the first price.** Every room card and the results header say "+ 5% payment processing fee" (every online payment pays it: cards, wallets and PromptPay), and the summary and payment step show it as its own line. The cancellation policy the guest agrees to says the fee is refunded only when the whole stay is refunded.
- **Alerts are not lost.** A failed send is logged and frees the repeat-suppression key, so the next occurrence retries; alerts are sent after the response with an 8 s relay/SMTP limit; **critical** alerts are stored in Redis until delivered and re-sent by every sweeper run (section 7).
- **Always the THB price shown.** Checkout Sessions pin Adaptive Pricing off, so no guest is charged a converted local-currency amount with Stripe's FX margin, and refunds stay in THB. Stays above Stripe's maximum charge (THB 999,999.99) are refused **before** any Cloudbeds write ("message us on WhatsApp").

### Files

| File | Role |
|---|---|
| `src/lib/booking/config.ts` | Provider switch, modes, live-lock, `BOOKING_ENGINE`, public config |
| `src/lib/booking/payments/provider.ts` | Fee per provider, card brands, redirect hosts (isomorphic) |
| `src/lib/booking/payments/stripe.ts` | Stripe client (official SDK, pinned), session params, session state, webhook verify |
| `src/lib/booking/cloudbedsWrite.ts` | Cloudbeds v1.3 writer: createHold, getReservation, recordPayment, addFeeItem, addNote, confirm, cancel, markPending, findHolds (every status, cautious creation time) |
| `src/lib/booking/testAccess.ts`, `src/app/api/booking/test-access/route.ts` | Stage B staff cookie (HMAC of `BOOKING_TEST_ACCESS_KEY`) |
| `src/lib/booking/cloudbedsProvider.ts` | Read side: roomRateID carried through, X-PROPERTY-ID, shared rate bucket, restrictions |
| `src/lib/booking/stripeCheckout.ts` | Hold-first checkout |
| `src/lib/booking/fulfil.ts` | fulfilSession, releaseHold, releaseSession, abandonSession |
| `src/lib/booking/stripeWebhook.ts` | Webhook dispatch |
| `src/lib/booking/sweep.ts` | Reconciliation sweeper |
| `src/lib/booking/abandon.ts` | Cancel/Back handling |
| `src/lib/booking/lock.ts`, `kv.ts`, `kvUpstash.ts` | Locks (fulfil, release, per-unit), markers, hold index, hold intents, `MSV-…[-TEST]` identifiers (Upstash Redis, or in memory for tests, mock and the MOCK writer) |
| `src/lib/booking/runtime.ts` | Wires real or mock dependencies for the routes; `getStripeFulfilmentDeps` keeps finishing Stripe sessions after a provider switch (drain) |
| `src/lib/booking/alerts.ts` | Alert delivery: retry on failure, short claim while sending, critical alerts stored until delivered (re-sent by the sweeper) |
| `src/lib/booking/mock/fakeStripe.ts`, `fakeCloudbeds.ts` | In-repo fakes, used by the tests and by `stripe-mock` |
| `src/app/api/stripe/webhook/route.ts` | Stripe webhook endpoint |
| `src/app/api/booking/{checkout,status,abandon,sweep,mock-stripe}/route.ts` | API |
| `src/app/booking-preview/stripe-mock/page.tsx` | MOCK Stripe checkout page (stripe-mock only) |
| `scripts/cloudbeds-wi0-check.mjs` | Read-only WI-0 verification |
| `src/app/booking/page.tsx` | `/booking`: our engine when `BOOKING_ENGINE=own` is active, else the Cloudbeds engine (unchanged) |
| `src/app/booking/classic/page.tsx`, `src/components/ClassicBookingPage.tsx` | Cloudbeds engine fallback page (noindex, no cross-URL canonical, linked `rel="nofollow"`) and the shared Cloudbeds page body |
| `src/app/booking/return/page.tsx`, `src/app/booking-preview/return/page.tsx`, `src/components/booking/OwnReturnPage.tsx` | Return pages (shared server body) |
| `src/components/booking/OwnBookingPage.tsx` | Shared server body of `/booking-preview` and the own `/booking` (prefill, landing key, Stripe cancel landing) |
| `src/components/booking/BookingApp.tsx` | Booking flow: steps, guest details sent at checkout (Stripe), redirect allow-list, abandon on Cancel/Back |
| `src/components/booking/attempt.ts` | This tab's last Stripe attempt (ref + signed link token), released before a new Pay |
| `src/components/booking/return/ReturnStatus.tsx` | Return-page views (paid, confirming, attention, pending, mismatch, unpaid) and polling |
| `src/lib/booking/paymentCopy.ts` | Provider-neutral copy, badges, preview-banner headline (isomorphic, tested) |
| `src/lib/booking/returnView.ts` | Which return view a status gets, retry rule, polling plans (isomorphic, tested) |
| `src/components/OwnDatePicker.tsx` | Homepage quick search when `BOOKING_ENGINE=own` (GET form to `/booking`) |

### Booking page (UI)

**Routes and the engine switch**

| Path | `BOOKING_ENGINE` unset / `cloudbeds` (default) | `BOOKING_ENGINE=own` (active) |
|---|---|---|
| `/booking` | Cloudbeds engine, exactly as before (still prerendered static) | Our engine, indexable, canonical `/booking`; a "classic booking page" link under the title |
| `/booking/classic` | Cloudbeds engine (noindex, no cross-URL canonical) | Same: the fallback |
| `/booking/return` | Return page (noindex). Kept working after a rollback so in-flight Stripe payments still confirm | Stripe's `success_url` |
| `/booking-preview`, `/booking-preview/return` | noindex preview (demo by default) | unchanged, still available |
| Homepage date picker | Cloudbeds `CloudbedsDatePicker` widget, untouched | `OwnDatePicker`: native date form (check-in, check-out, guests) that GETs `/booking?checkin&checkout&adults`; reserves at least the widget's measured height |
| Header / hero "Book Now" | `/booking` | `/booking` (unchanged) |

"Active" means `resolveBookingEngine()`: on the production deployment `own` only takes effect while stripe-live is fully unlocked, so a demo/test/locked engine never replaces the public page. Pages read the env at build time: **redeploy after changing it**. With `own`, the Cloudbeds script is only loaded on `/booking/classic` (nothing else needs it), and the WhatsApp button sits above our engine's bottom bars.

**What the guest sees per provider**
- **Stripe:** steps Search → Choose your room → Add Guests → Review and pay (no add-ons step; Standard Rate only). The guest form adds an optional **Postcode / ZIP** (Cloudbeds `guestZip`; a placeholder is sent when empty) and is re-validated on the server. Copy names Stripe only: "Pay securely with Stripe", "Secure payment by Stripe", badges **Visa, Mastercard, PromptPay, Apple Pay, Google Pay**, fee line **"Payment processing fee (5%)"** from the config, and a note that the room is held for 30 minutes while paying.
- **Beam / demo:** unchanged wording and badges (Visa, Mastercard, JCB, Amex, UnionPay, PromptPay), fee 3%.
- `?promo=DIRECT` (or any code) is dropped quietly when promos are off: no error, no code shown. The "Add Code" pill is not offered at all while promos are off (every Beam/Stripe mode), so a guest never sees a code as entered that would not change the price; a code left in a saved search is not sent.

**Pay, Cancel and Back (Stripe)**
- Pay sends the cart (never prices) plus the guest details in the request body, then follows the redirect only if it is our origin or `checkout.stripe.com` (or Beam's hosts) - `isAllowedPaymentRedirect`.
- Stripe's back link lands on `<page>?resume=payment&reason=cancelled&ref&t`. The page reads `ref`/`t` on the server, POSTs `/api/booking/abandon` at once and keeps Pay disabled ("Checking your earlier payment...") until it answers: `paid`/`pending` → the return page (never a second charge); `released`/`closed` → Pay creates a new hold.
- The browser's own Back button from Stripe: the tab remembers its last attempt (ref + signed link token + start time, no personal data). The next Pay first abandons that attempt the same way, so the old hold never blocks the new one.
- If that check fails (Stripe or our server unreachable), Pay does **not** open a second payable Stripe session while the earlier one could still be paid (33 minutes from its start): the guest sees "We couldn't check your earlier payment attempt just now ..." with WhatsApp and can press Pay again a minute later. After 33 minutes the earlier session has certainly expired at Stripe and Pay carries on. A session Stripe says does not exist counts as closed.
- Errors: `price_changed` without a quote (Cloudbeds priced the hold differently; it was cancelled) refreshes the search once and offers WhatsApp - never an automatic retry. `test_mode_restricted` offers "Change dates" / "Edit guest details". A stay rule (minimum stay, closed to arrival...) names the rule.

**Return page states (Stripe)**

| Status | Fulfilment | Shows |
|---|---|---|
| pending | awaiting_payment | "Waiting for your payment..." - checks every ~3 s for 3 min, then "don't pay again, message us" |
| paid | confirming | "Payment received - confirming your booking" - keeps checking; never "Try again" |
| paid | confirmed | Success: booking reference + **Cloudbeds reservation number**; GA4 `purchase` only when the server sends it (live production) |
| paid | needs_attention | "Payment received - we'll contact you" + WhatsApp; never "Try again" |
| expired | released | "Payment time ran out" - the room was released; Try again |
| cancelled | released | "Payment cancelled" - hold released; Try again |
| failed (PAYMENT_FAILED) | released | "Payment didn't go through"; Try again |
| failed (AMOUNT_OR_REFERENCE_MISMATCH) | - | "We need to check this payment" - contact us only |

"Try again" returns to the page the booking was made on (`/booking` or `/booking-preview`) with the cart still saved.

**Default pages stay as they were.** `/booking` and the homepage import our engine only behind a code-split boundary (`components/booking/BookingAppLazy.tsx`, `components/OwnDatePickerLazy.tsx`, both `next/dynamic`, still server-rendered when used), so with the default `BOOKING_ENGINE` their JavaScript is what it was (a few KB of loader only). The engine's Tailwind classes are generated in its own sheet: `globals.css` leaves `src/components/booking` and `src/app/booking-preview` out (`@source not`), and `components/booking/booking.css` builds the utilities for all of `src/` (a complete, correctly ordered superset that loads after `globals.css`, only with the engine). Shared tokens live in `src/app/tailwind-theme.css`. `globals.css` also skips `src/lib/booking`, `docs/` and `scripts/`. The homepage's `OwnDatePicker` (outside `src/components/booking`) is still scanned into `globals.css`, so the shared sheet is a few hundred bytes larger than on `main` (56.4 KB in the current build; only added utilities, no reordering). Otherwise every non-booking page's render-blocking CSS is as on `main`, and on booking pages the computed style of every element is identical to the single-sheet build (checked element by element at 375 px and 1280 px). If you add a page outside `src/components/booking` that renders booking components, import `components/booking/booking.css` there (the MOCK Stripe page does).

**Preview banner** (hidden on a fully live Stripe page): provider (Stripe / Beam / Simulated payments), mode (Demo / MOCK / Test mode / LIVE / Locked), data source (live Cloudbeds or simulated) and, for Stripe, whether a real Cloudbeds reservation is written. Locked shows the reason and a WhatsApp link.

**Privacy and legal.** With `BOOKING_PAYMENT_PROVIDER=stripe`, `/privacy` adds that guest details entered on our own direct booking page (where it is offered) pass through our server to Cloudbeds and are kept by us only briefly as a one-way code (the per-guest hold brake: a keyed hash of IP + email in Redis for about 40 minutes), that Stripe processes card, Apple Pay, Google Pay and PromptPay payments, uses payment data for its own purposes under its own privacy policy (linked) and sets its own checkout cookies, and lists Stripe and Upstash (temporary booking-process data) as processors; `/legal` adds "Online payments on our own direct booking pages may be processed by Stripe". The wording is true in every phase, including Stage B and the soft launch while the public `/booking` is still Cloudbeds. **These public pages change as soon as the provider is set to `stripe` (Stage B setup).** Without it both pages read exactly as before.

**Homepage copy.** While `BOOKING_ENGINE=own` is active, the "Best rate, always - Code DIRECT at checkout" perk on the homepage and on the seven language pages is replaced automatically by "Book direct, instantly" (translated), because promo codes are off on our engine. With the default engine the copy is unchanged. **The legal entity named is unchanged - see section 10.**

---

## 2. Environment variables

Set these in Vercel under **Project → Settings → Environment Variables**. Scope live secrets to **Production** only and mark them sensitive. **Redeploy afterwards**, because changes only apply to new deployments.

| Variable | Needed for | Notes |
|---|---|---|
| `BOOKING_PAYMENT_PROVIDER` | all | `stripe` \| `beam` \| `demo`. Unset keeps the legacy behaviour (demo, or Beam if `BEAM_API_BASE` is set). |
| `STRIPE_SECRET_KEY` | stripe | Restricted key `rk_test_…` / `rk_live_…` (or `sk_…`). Test vs live comes from the prefix. |
| `STRIPE_WEBHOOK_SECRET` | stripe (required live) | `whsec_…` of the endpoint `https://magicsamui.com/api/stripe/webhook`. Test and live secrets differ. |
| `STRIPE_PAYMENT_METHOD_TYPES` | optional | Default `card,promptpay` (a filter on the account's enabled methods). `dynamic` = no filter. |
| `CLOUDBEDS_API_KEY` | reads | Existing read key, left as is. |
| `CLOUDBEDS_API_KEY_BOOKING` | stripe writes (required live) | New key with write scopes (see 4.B). Without it, stripe-test uses the MOCK writer and the page says so. |
| `CLOUDBEDS_PROPERTY_ID` | with the booking key | `235064` (confirm with WI-0). |
| `CLOUDBEDS_STRIPE_PAYMENT_METHOD` | optional | Code of the custom Cloudbeds payment method. Default `stripe`. |
| `CLOUDBEDS_STRIPE_TEST_PAYMENT_METHOD` | optional, test only | Code of a separate Cloudbeds method (e.g. "Stripe TEST") for test-mode payments. Ignored in live. |
| `CLOUDBEDS_RESERVATION_PAYMENT_METHOD` | optional | postReservation `paymentMethod`: `credit` (default), `cash`, `ebanking` or `pay_pal`. |
| `CLOUDBEDS_SEND_STATUS_EMAIL` | optional | `true` = Cloudbeds emails the guest when we confirm (decide after Stage B test 12). Default off. |
| `BOOKING_GUEST_ZIP_PLACEHOLDER` | optional | guestZip when the guest has no postcode. Default `00000` (WI-0: confirm it is accepted). |
| `BOOKING_TOKEN_SECRET` | stripe/beam, production | 32+ random characters. |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` (or `KV_REST_API_URL` / `KV_REST_API_TOKEN`) | required live **and** with `CLOUDBEDS_API_KEY_BOOKING` (Stage B too) | The Vercel Upstash integration creates these. Real Cloudbeds writes are refused without them (`payment_misconfigured`), because an in-memory lock is per serverless instance. Only stripe-mock and stripe-test with the MOCK writer run in memory (with a logged warning). |
| `BOOKING_TEST_GUEST_EMAIL` | stripe-test with real writes | A **private plus-address that is never published** (e.g. `yourname+msv-stage-b@gmail.com`), not info@. Holds are refused for any other email. |
| `BOOKING_TEST_ACCESS_KEY` | stripe-test with real writes | 16+ random characters. Staff unlock test holds per browser with it (section 5, Stage B). Without it every real test hold is refused. |
| `BOOKING_ALLOW_LIVE_PAYMENTS` | live | `true` only at go-live. `false` + redeploy = emergency stop. |
| `BOOKING_ENGINE` | cutover | `own` \| `cloudbeds` (default). On production `own` only takes effect while stripe-live is fully unlocked. |
| `BOOKING_SWEEP_SECRET` (or `CRON_SECRET`) | sweeper, **required live** | 16+ characters. Bearer token for `/api/booking/sweep`. When both are set, **both** are accepted (the droplet cron sends `BOOKING_SWEEP_SECRET`, a Vercel cron `CRON_SECRET`). Neither set = sweeper disabled (404) and live payments locked. In live, checkout alerts when no sweep has succeeded for 30 minutes. |
| `BOOKING_ALERT_EMAIL` | optional | Where alerts go. Default `info@magicsamui.com`. Sent through `sendSiteMail`, which only reaches our own addresses. |
| `BOOKING_ALERTS_IN_TEST` | optional | `true` = email alerts in test mode too (default: log only outside live). |
| `BOOKING_CARD_FEE_PCT` | optional | Overrides the fee for **whichever provider is active** (defaults: stripe 5, beam 3, demo 3). One value covers every provider, so **unset it when switching providers** (e.g. to Beam later) unless the same fee is intended - otherwise Beam would charge the Stripe override. `0` switches the fee off. |
| `BOOKING_STRIPE_MOCK` | local only | `true` + provider stripe + no key = MOCK mode. Refused on production. |
| `NEXT_PUBLIC_VERCEL_ENV` | live analytics | Vercel provides it only with **Settings → Environment Variables → "Automatically expose System Environment Variables"** on. The GA4 `purchase` is only sent when it is `production` (checked in Stage C step 4). |
| `BOOKING_DEPOSIT_PCT` | beam/demo only | Deposit % (default 100). Stripe always takes 100%. |
| `BOOKING_DEMO_PROMO_PCT` | demo only | DIRECT discount in demo mode (default 10). Promos are off in every other mode. |
| `BOOKING_VERCEL_TEAM_SLUG`, `BEAM_API_BASE`, `BEAM_MERCHANT_ID`, `BEAM_API_KEY`, `BEAM_WEBHOOK_HMAC_KEY` | Beam / preview URLs | See `docs/booking-beam-preview.md`. |
| `BOOKING_MOCK_HOLD_PRICE_DELTA_BAHT` | stripe-mock only | e.g. `500`: the fake Cloudbeds prices every hold that many baht off the quote, to click through "price changed between quote and hold" (hold cancelled, `price_changed`, nothing charged). Ignored in every other mode. |

---

## 3. WI-0 desk check (from research; confirm live with `scripts/cloudbeds-wi0-check.mjs`)

I had no write key, so this is a desk check of the official docs and the OpenAPI specs (research files `cloudbeds-api.md`, `site.md`). Each point says what the code assumes and what to confirm live. **Run the script with the new booking key and paste its output here before Stage B.**

| # | Question | What the code does now | Confirm live |
|---|---|---|---|
| 1 | Is `roomRate` per night or per stay? | Ignores `roomRate`. The stay total is the sum of `roomRateDetailed[].rate` over the nights. | Script section 3 prints both. |
| 2 | Do rates include VAT and service charge? | Assumes inclusive: the hold's `grandTotal` must equal our room subtotal, otherwise the booking is refused (`price_changed`) and the owner is alerted. | Script section 4. Any `exclusive` tax/fee will block every booking until handled. |
| 3 | Do combos (Tower Club 3BR = Honeymoon + Seaview 2BR, etc.) share inventory? | Relies on Cloudbeds' `roomsAvailable` per room type and never computes combos itself. | Script section 5, plus Stage B test 10. |
| 4 | What is `tuxedo-3br`'s roomTypeID? | It has none in code, so it is not bookable online (enquiry card). | Script section 2 lists every room type. Add the id to `src/data/cloudbeds.ts` if it exists. |
| 5 | Is the propertyID 235064? | `CLOUDBEDS_PROPERTY_ID` is required with the write key. | Script section 1. |
| 6 | What gateway does Cloudbeds use, and what is the "Stripe" method code? | `CLOUDBEDS_STRIPE_PAYMENT_METHOD` defaults to `stripe`. | Script section 6 (`getPaymentMethods`, needs `read:payment`). |
| 7 | Which postReservation fields are required? Is a guestZip placeholder accepted? | Sends startDate, endDate, guest name/email/phone/country/zip, rooms, adults, children=0, paymentMethod, thirdPartyIdentifier, `sendEmailConfirmation=false` and estimatedArrivalTime. guestZip is `00000` when empty. | First Stage B booking. |
| 8 | What status does an API booking get, and does `not_confirmed` block OTA inventory? | Sets `not_confirmed` after creating the hold. | Stage B test 14 - a **go/no-go gate**, checked DURING a pending hold (tests 1 and 5 only see it after payment / after cancel). |
| 9 | What happens on `postReservation` at `roomsAvailable=0`? | Our own checkouts are serialised per physical unit (Redis lock) with a fresh restriction + availability check under the lock, so we never overbook ourselves. An availability refusal becomes `unavailable`; any other refusal is alerted and shown as "message us". | Stage B test 11 - a **go/no-go gate** (see there). |
| 10 | Can we reference the Stripe charge **natively**, since this Stripe account is the Cloudbeds gateway? | **No, not for hold-then-pay.** See the note below. We use `postPayment` with the custom "Stripe" method and put the Stripe ids in the description. | – |
| 12 | Does `getRatePlans` (asked with `endDate` = check-out + 1 day) return a row for the **departure day**, so closed-to-departure can be enforced? And does every row carry the arrival day? | Asks one day past check-out and checks only the stay nights for blocked/sold out. A row without the arrival day counts as "not checked" (alert "Stay rules not checked"), never as passed. | Script / Stage B case 16. |
| 13 | Does `getAvailableRoomTypes` return the **base (BAR) row** (no `ratePlanNamePublic`, no `derivedType`) for every room type? | Stripe modes sell only that row; a room type with only package / derived rows is shown unavailable (log `cloudbeds_no_base_rate`). | Script section 3, plus Stage B case 17. |
| 11 | Does `getReservations` return `thirdPartyIdentifier` and `dateCreated` (the v1.3 schema has no `dateCreatedUTC` there), and in which zone does it read `resultsFrom`/`resultsTo`? | The sweeper needs `thirdPartyIdentifier` to find holds whose `postReservation` answer was lost (our Redis index and intents cover every attempt, but only Cloudbeds knows the reservation id of a lost answer). It pads the window by 8 h and ages every hold by our own record or intent, so the zone question cannot make it release a fresh hold. | Script section 8. |

**Native Stripe reference (research note, Oct 2026).** Cloudbeds' `postReservation` has two Stripe-only fields.
- `cardToken`: a Stripe **Customer** id. Cloudbeds saves the card for later charges.
- `paymentAuthorizationCode`: the **Charge** id behind a PaymentIntent. Cloudbeds treats it as the deposit.

These fields have limits:
- They exist only **when the reservation is created**, and `paymentAuthorizationCode` requires `cardToken`. So the charge must exist before the reservation. That is pay-first, the opposite of our hold-first flow.
- There is no equivalent field on `postPayment` or `putReservation`.
- They require a Stripe Customer with an attached payment method, which Checkout in payment mode does not create.

Sources:
- https://developers.cloudbeds.com/docs/pass-stripe-tokens-to-cloudbeds
- https://developers.cloudbeds.com/reference/post_postreservation-2

We therefore use the documented external-payment path: `postPayment` + `putReservation`, as in https://developers.cloudbeds.com/docs/booking_engine_payment.

---

## 4. Owner setup (he pastes every secret himself; we never see them)

### A. Stripe

1. **Account.**
   - Use the existing Thai Stripe account that is connected to Cloudbeds.
   - Before any live use, check that it is activated for the entity that sells the stays.
   - Ask Stripe Thailand to confirm a pool-villa hotel is approved, which licence documents they accept, and any reserve on bookings paid months ahead.
2. **Payment methods.** In `dashboard.stripe.com/settings/payment_methods`, turn on **Cards**, **Apple Pay**, **Google Pay** and **PromptPay**.
3. **Test key.**
   - Developers → **API keys**, in a sandbox or test mode → **Create restricted key**, name it `magicsamui-booking`.
   - Permissions: **Checkout Sessions: Write** (create, list, retrieve and expire sessions) and **PaymentIntents: Read**, everything else **None**. Stage B step 0 confirms the key really can create a `price_data` session, list and expire sessions (the request log shows any permission error); widen only what it names.
   - **Create key** → two-step verification → copy it into `STRIPE_SECRET_KEY` (Vercel, Production).
4. **Test webhook.** Do this **after** the Vercel variables (4.D-E below and section 2) are set and redeployed, so the endpoint answers 2xx from the first event (Stripe disables an endpoint that keeps failing).
   - **Workbench → Webhooks → Create an event destination** → **Your account** → API version **`2026-09-30.endive`** (the version the pinned SDK is written against - event payloads follow the endpoint's version, so do not pick a newer one).
   - Events:
     - `checkout.session.completed`
     - `checkout.session.async_payment_succeeded`
     - `checkout.session.async_payment_failed`
     - `checkout.session.expired`
   - **Continue** → **Webhook endpoint** → URL `https://magicsamui.com/api/stripe/webhook`.
   - Open the endpoint → **Reveal secret** → `STRIPE_WEBHOOK_SECRET`.
5. **Live, later.** Switch to live mode and repeat steps 3–4. Live keys start `rk_live_`, and the live webhook secret is different.
6. **Receipts - nothing to switch on.** Each Checkout Session sets `payment_intent_data.receipt_email`, and Stripe then emails a live-mode receipt to that address whatever the account's email settings are. **Leave Settings → Customer emails → "Successful payments" as it is**: this account is also Cloudbeds' gateway, and switching it on would start emailing receipts for the charges Cloudbeds makes too. (Stripe sends no receipts in test mode, so Stage C step 4 checks the first real one.)

### B. Cloudbeds

1. **New API key.** Leave the current `CLOUDBEDS_API_KEY` alone.
   - **Account** (top right) → **Apps & Marketplace** → **API Credentials** → **+ New Credentials**.
   - Open the new row → **API Key** → **Create**.
   - Tick these scopes:
     - `read:room`, `read:rate`, `read:hotel`, `read:taxesAndFees`, `read:reservation`, `read:payment`
     - `write:reservation`, `write:payment`
     - `write:item` (for the fee line, `postCustomItem`)
   - Click **Create** and copy the key **immediately**, because it is shown once. It goes into `CLOUDBEDS_API_KEY_BOOKING`.
   - Scopes cannot be added to a key later.
2. **Custom payment method.** **Account → Settings → Finance → Additional and Custom Payment Methods → + Add Payment Type**, and name it **Stripe**. Then run the WI-0 script and put the code it prints in `CLOUDBEDS_STRIPE_PAYMENT_METHOD` if it isn't `stripe`.
3. **Confirmation policy.** Tell us whether the "Confirmation Pending" policy or "auto-confirm on payment" is on.

### C. Redis (lock and idempotency)

In the Vercel project, add **Upstash Redis** from the Marketplace (**Storage → Create Database → Upstash → Redis**, connect it to this project for all environments). It sets its own env vars. Live mode **and** Stage B (real Cloudbeds writes with test keys) refuse to run without them. Stage B and live may share the database: hold and intent records carry their mode, and the keys that are not tied to one record (alert claims, stored critical alerts, the last sweep, failure counters, the paid-but-unconfirmed list) are prefixed with the mode (`msv:live:…`, `msv:stripe-test:…`), so a test deployment and its sweeper never touch the live ones. A separate database for Stage B is still the cleanest choice if the plan allows it.

### D. Sweeper (required for live)

Set `BOOKING_SWEEP_SECRET` (32 random characters) - live payments stay locked without it. Vercel Hobby crons run once a day, so call the sweeper every 10 minutes from the droplet's cron:

```
*/10 * * * * curl -fsS -X POST -H "Authorization: Bearer $BOOKING_SWEEP_SECRET" https://magicsamui.com/api/booking/sweep >/dev/null
```

On Vercel Pro, a `vercel.json` cron works too. It sends `Authorization: Bearer $CRON_SECRET`; the sweeper accepts `CRON_SECRET` **and** `BOOKING_SWEEP_SECRET` when both are set, so the droplet cron and a Vercel cron can run side by side.

Each run answers counts only, e.g. `{"ok":true,"mode":"stripe-live","released":0,"openHolds":0,"paidUnconfirmed":0,"pruned":0,"undeliveredAlerts":0,"cloudbedsOk":true,...}`. **`paidUnconfirmed` must be 0**: anything else is a paid booking whose Cloudbeds confirmation keeps failing (the owner is alerted; never cancel it). **`openHolds` must be 0 before any change of provider or Stripe keys** (section 6, drain). When the run could not list Cloudbeds reservations it answers **HTTP 502** `{"ok":false,"error":"cloudbeds_unavailable",...}`, so `curl -f` exits non-zero (the droplet's cron mail shows it), and it does not count as a sweep. In live, checkout emails "The booking sweeper has not run recently" when no sweep with a working Cloudbeds side has run for 30 minutes.

### E. Stage B staff key

Set `BOOKING_TEST_ACCESS_KEY` (16+ random characters) and `BOOKING_TEST_GUEST_EMAIL` (a private plus-address, never published) for Stage B only, and remove both after Stage B.

### F. GA4

**Admin → Data streams → Web → (stream) → Configure tag settings → Show all → List unwanted referrals** → add `checkout.stripe.com` → **Save**.

**Keep user-provided data OFF.** In **Admin → Data collection and modification → Data collection**, leave **"User-provided data collection"** (and its automatic detection) **off**. With it on, the Google tag looks for email addresses on the conversion page and in submitted forms and sends them to Google (hashed) - but `/privacy` promises that we do not upload email addresses or phone numbers to advertising platforms. If you ever want it on, `/privacy` must change first.

### G. Google Ads (before the swap)

Ads counts bookings only through the GA4 `purchase` import (Purchase conversion action). Before `BOOKING_ENGINE=own`:
1. **Google Ads → Goals → Conversions → Summary**: open the Purchase action and confirm its source is the GA4 import (`purchase` key event).
2. **Cloudbeds → Settings → Booking Engine → (Google Ads / analytics fields)**: note whether a direct Ads conversion ID/label is configured. Those hits stop when `/booking` serves our engine; the GA4 import replaces them - make sure Purchase is not counted twice during the 2-week overlap.
3. **GA4 → Admin → Key events / Audiences**: check whether anything uses `booking_engine_view` or `booking_engine_interact` (fired only by the Cloudbeds engine page). They stop on `/booking` after the swap; move such audiences/key events to `begin_checkout` / `add_to_cart` / `purchase`.
4. **Ad copy**: remove "best rate" / "cheapest when you book direct" claims from ads while our engine adds the processing fee (the site itself drops that wording automatically while `BOOKING_ENGINE=own`).
5. **Keep enhanced conversions OFF**: **Goals → Conversions → Settings → Enhanced conversions** must stay off (the Ads UI suggests turning it on regularly). Automatic enhanced conversions read email addresses from the conversion page and forms and send them to Google, which `/privacy` says we do not do. Change `/privacy` first if that ever changes.

---

## 5. Test protocol

Cloudbeds has **no sandbox**. Every Stage B test writes to the **live property** and briefly blocks real OTA inventory.

### Stage A: local, no Cloudbeds writes

1. Run `node --test src/lib/booking`. All tests must pass. They cover:
   - Cloudbeds `success:false` with HTTP 200
   - tampered and old Stripe signatures
   - 5 concurrent fulfils producing exactly 1 postPayment
   - expire → cancel, and a paid booking never cancelled
   - the price assert
   - the live-lock matrix
   - the test-mode guard
   - the fee per provider
   - the satang/baht boundary
   - a postReservation that times out after Cloudbeds created a CONFIRMED reservation: alert, then the next stale sweep cancels it
   - two concurrent checkouts for the last unit against a Cloudbeds that would overbook: exactly one hold
   - the sweeper never releasing a fresh hold; test vs live holds never crossing
   - a staff-confirmed hold never auto-cancelled; the fee line never blocking a confirmation
   - drain after a provider switch; the Stage B staff key; the hold brakes
   - mode-scoped alert / sweep keys (a test sweeper never hides or re-sends live ones); the fee item per mode with a static note
   - a paid booking whose confirmation keeps failing: "PAID - do not cancel" note, retried by the sweeper past 48 h, CRITICAL after 2 h; a checked-in guest is never moved back to confirmed
   - a confirmed `MSV-` reservation with no record is never cancelled; the overlap check reads only fresh holds; old index entries are pruned
   - base-rate-only availability; departure-day restrictions; deadline-bound Cloudbeds writes; both sweeper secrets accepted
2. **MOCK click-through (no keys).**
   - Run `BOOKING_PAYMENT_PROVIDER=stripe BOOKING_STRIPE_MOCK=true npm run dev`, then open `http://localhost:3000/booking-preview`.
   - Add `BOOKING_ENGINE=own` to test the cutover locally: `/booking` then serves our engine, `/booking/classic` the Cloudbeds one, and the homepage shows our date form.
   - Book a room. The MOCK Stripe page offers: pay, delayed success, delayed failure, expire and back.
   - Check: no add-ons step, the Postcode field, "+ 5% payment processing fee" under each room card's price and "Payment processing fee (5%)" in the summary, Stripe badges only; Back → the hold is released (log `booking_abandoned ... released`); browser Back then Pay → the old hold is released before the new one; Pay → "Booking confirmed" with the reservation number; expire / delayed failure → "Payment time ran out" / "Payment didn't go through" with Try again.
   - Everything is labelled MOCK, and the log shows the fake Cloudbeds calls.
   - Availability is demo data in this mode.
   - Next's dev server does not forget variables removed from `.env.local`: restart it after removing them.
   - Price changed between quote and hold: add `BOOKING_MOCK_HOLD_PRICE_DELTA_BAHT=500`, restart, Pay → "The price has just changed" (log `hold_price_mismatch`, `hold_released ... price mismatch`), no Stripe session.
   - Duplicate webhooks: the MOCK webhook secret is public, so signed duplicates of `checkout.session.completed` can be POSTed to `/api/stripe/webhook` while the return page polls; the log must show exactly one `postPayment` (and one `postCustomItem`) per booking.
   - Live lock: `BOOKING_PAYMENT_PROVIDER=stripe` + any `STRIPE_SECRET_KEY=sk_live_…` with the other live conditions missing → banner "Stripe · Locked", Pay disabled with "Payments are locked … WhatsApp us", and `POST /api/booking/checkout` answers 503 `live_payments_locked`.
3. **Real Stripe test mode, mocked Cloudbeds.**
   - Set `STRIPE_SECRET_KEY=rk_test_…` and **no** `CLOUDBEDS_API_KEY_BOOKING`.
   - Run `stripe listen --forward-to localhost:3000/api/stripe/webhook` and copy the printed `whsec_…` into `STRIPE_WEBHOOK_SECRET`.
   - Pay with `4242 4242 4242 4242`, then with `4000 0027 6000 3184` (3-D Secure), then with `4000 0000 0000 9995` (declined).

### Stage B: production domain, Stripe test keys, REAL Cloudbeds

**Setup**
- Use the unlinked `/booking-preview` with `rk_test_` keys and `CLOUDBEDS_API_KEY_BOOKING`. Upstash Redis must be connected (real writes are refused without it).
- Setting `BOOKING_PAYMENT_PROVIDER=stripe` on Production already changes the public `/privacy` and `/legal` pages (worded so they stay true while `/booking` is still Cloudbeds).
- Set `BOOKING_TEST_GUEST_EMAIL` to a **private plus-address that is never published** (not info@) and `BOOKING_TEST_ACCESS_KEY` to 16+ random characters. Redeploy.
- **Unlock this browser** (once per browser, valid 12 hours): open `https://magicsamui.com/booking-preview`, press F12 → Console, and run
  ```
  fetch("/api/booking/test-access", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "PASTE BOOKING_TEST_ACCESS_KEY" }) }).then((r) => r.json()).then(console.log)
  ```
  It prints `{ ok: true, validForHours: 12 }` and sets an httpOnly cookie (an HMAC of the key, never the key). `fetch("/api/booking/test-access", { method: "DELETE" })` removes it.
- Holds are refused unless this browser is unlocked, the guest email is the test address **and** the arrival is **12+ months ahead**. The refusal never says which check failed.
- Analytics: with test keys gtag.js and Clarity never load on `/booking-preview*`, so Stage B leaves no trace in GA4 or Ads.
- **Step 0 - Stripe key.** Make one booking and check Stripe → Developers → Logs: the restricted key created the Checkout Session (`price_data`), and (after Cancel) listed and expired sessions without a permission error. Widen only what an error names. In the same log entry, confirm the request carried `adaptive_pricing[enabled]=false` (also check **Settings → Payments → Adaptive Pricing**: off or not offered for this account).

**For every test**
- Pick a far-future, low-demand date.
- Note the reservation id (shown on the return page; the `thirdPartyIdentifier` ends in `-TEST`).
- Check the Cloudbeds calendar and the Booking.com/Airbnb extranets before and after (and **during** the pending hold for test 14).
- **Clean up each paid test booking in Cloudbeds, in this order:** (1) folio → reverse the "Stripe" (or "Stripe TEST") payment with a refund/adjustment entry for the same amount; (2) remove or void the "TEST - Payment processing fee" item; (3) cancel the reservation; (4) write the reservation id and the date in the Stage B log. Cancelling alone leaves the test payment and fee in Cloudbeds' payment and revenue reports. Everything test-made is labelled `TEST MODE - NOT REAL MONEY`; a separate Cloudbeds method set in `CLOUDBEDS_STRIPE_TEST_PAYMENT_METHOD` keeps it out of the real "Stripe" method entirely.

**Cases**
1. **Card success.** Cloudbeds shows the fee line and the payment (type Stripe), balance 0, confirmed. The OTAs show the dates closed.
2. **No Cloudbeds email on the hold.** Right after pressing Pay (hold created, still on the Stripe page, **before** paying), check the test inbox: **no** Cloudbeds email may arrive (`sendEmailConfirmation=false` is sent as the string `false`; how Cloudbeds parses it is undocumented). If one arrives, stop: the booleans must be sent as `0`/`1` before go-live.
3. **3-D Secure and declined cards.** The hold stays until expiry or Cancel.
4. **PromptPay** test payment.
5. **Cancel (back link).** The session expires, the hold is cancelled and the OTAs reopen within minutes. The page says the room is no longer held.
6. **Let a session sit 31 min.** The `expired` event cancels the hold.
7. **Duplicates.** Run `stripe events resend <evt>` and load the return page at the same time. There is still exactly one folio payment.
8. **Webhook failure.**
   - Temporarily remove `STRIPE_WEBHOOK_SECRET`; the endpoint answers 503.
   - Restore it and resend: the booking completes.
   - Separately, disable the endpoint, pay, then run the sweeper: it confirms the booking.
9. **Price change.** Change the price in Cloudbeds between quote and Pay. The guest gets `price_changed`, no charge, and the owner an alert.
10. **Combo conflict.** Hold Honeymoon, then confirm Tower Club 3BR is no longer offered for those dates. Also try to **book** Tower Club 3BR for the same dates from a second browser while the Honeymoon hold is open: our engine must refuse it ("another guest is completing a booking") without calling `postReservation` (log `checkout_refused_open_hold_overlap`).
11. **Zero availability - GO/NO-GO GATE.** Hold the only unit of a 1-unit type through the page (e.g. Garden Suite, `462961`), then, with the hold still open, post a second reservation for the same type and dates **directly** (our own engine would refuse it before asking Cloudbeds):
    ```
    curl -sS -X POST https://api.cloudbeds.com/api/v1.3/postReservation \
      -H "x-api-key: $CLOUDBEDS_API_KEY_BOOKING" -H "X-PROPERTY-ID: 235064" \
      --data-urlencode "propertyID=235064" --data-urlencode "startDate=YYYY-MM-DD" --data-urlencode "endDate=YYYY-MM-DD" \
      --data-urlencode "guestFirstName=Test" --data-urlencode "guestLastName=Overbook" --data-urlencode "guestEmail=PRIVATE-TEST-ADDRESS" \
      --data-urlencode "guestPhone=+66 000000000" --data-urlencode "guestCountry=TH" --data-urlencode "guestZip=00000" \
      --data-urlencode "rooms[0][roomTypeID]=462961" --data-urlencode "rooms[0][quantity]=1" \
      --data-urlencode "adults[0][roomTypeID]=462961" --data-urlencode "adults[0][quantity]=2" \
      --data-urlencode "children[0][roomTypeID]=462961" --data-urlencode "children[0][quantity]=0" \
      --data-urlencode "paymentMethod=cash" --data-urlencode "thirdPartyIdentifier=WI0-TEST11" --data-urlencode "sendEmailConfirmation=false"
    ```
    - `"success":false` (no availability): **GO**. Our engine serialises its own holds per unit and re-checks under the lock; an OTA race is refused by Cloudbeds.
    - `"success":true` (Cloudbeds overbooked): cancel that reservation at once by hand. **NO-GO** until a post-hold check is built (after `postReservation`, re-read availability / the reservation's room assignment and cancel + "unavailable" if it overbooked). Our unit lock already stops our own checkouts double-booking each other, but an OTA booking landing between our re-check and the hold would be overbooked.
    - **Combination case.** Repeat with a combination type: hold **Honeymoon** (`462958`) through the page, then `curl` the same `postReservation` with `575061` (Tower Club 3BR, which shares the Honeymoon unit) on the same dates. `"success":false` = GO; `"success":true` = NO-GO as above (cancel it by hand at once).
    - The sweeper never touches `WI0-TEST11` (not one of our identifiers): always cancel it by hand.
12. **Confirmation email.** Set `CLOUDBEDS_SEND_STATUS_EMAIL=true` with the test address and check which template arrives. Keep it `true` only if that email is a proper booking confirmation; the booking page and return page then promise a confirmation email, otherwise only Stripe's receipt.
13. **Orphan recovery.** Run `scripts/cloudbeds-wi0-check.mjs` section 8 and paste its output into section 3 row 11. Check that `dateCreated` is Bangkok time (if it is UTC, a no-record orphan is released ~7 h earlier; nothing else changes).
14. **Pending holds block inventory - GO/NO-GO GATE.** Press Pay and **stay on the Stripe page** (do not pay) while the hold is `not_confirmed` ("Confirmation pending" in Cloudbeds). Within the 30 minutes check:
    - (a) `getAvailableRoomTypes` for those dates (script section 5, or Cloudbeds' own booking engine) no longer lists that room type / its `roomsAvailable` dropped by one;
    - (b) our own search no longer offers it (another browser);
    - (c) the **Booking.com and Airbnb extranets** show those dates closed.
    - All three: **GO**. If any fails, pending reservations do not block inventory: stop calling `markPending` (keep API holds `confirmed`, relying on the note and the `MSV-` third-party id - remove the `markPending` step in `src/lib/booking/stripeCheckout.ts`), then re-run this test and tests 1, 5 and 10.
15. **Largest charge.** Price a long stay in the most expensive room above THB 999,999.99: the page refuses it before any hold ("message us on WhatsApp"). Then try one PromptPay test payment of a large amount (e.g. THB 200,000): if PromptPay refuses it, note its cap here and lower `STRIPE_MAX_CHARGE_SATANG` (or restrict PromptPay) before go-live.
16. **Stay rules incl. departure.** In Cloudbeds set **closed to departure** on a far-future date for one room type, then try to book a stay ending that day: refused with "can't be booked with departure on this date", nothing held. Remove the restriction afterwards. (Confirms WI-0 row 12: `getRatePlans` returns the departure day's row.)
17. **Base rate only.** Note which rate plans Cloudbeds returns for a test date (script section 3). If a room type has a package or derived plan, close the **base** rate for one date and search it: our page must show that room as unavailable (log `cloudbeds_no_base_rate`), never the package's price. Re-open the base rate afterwards.
18. **Fee lines and notes per booking.** After two paid test bookings (case 1 twice), open both folios: each has a **"TEST - Payment processing fee"** item for its own amount with the static test note (no ref, no `pi_…`), and each reservation has its **own** note "TEST MODE - NOT REAL MONEY. PAID via Stripe pi_… for online booking MSV-…" with its own ref and PaymentIntent. The live item ("Payment processing fee") is a different item: it never shows test text.

### Stage C: one real live booking

1. **Drain the test phase first** (section 6, "Changing the provider or the Stripe keys"): stop new test holds, wait until the sweeper reports `openHolds: 0`, then remove `BOOKING_TEST_GUEST_EMAIL` and `BOOKING_TEST_ACCESS_KEY`.
2. Set the live keys and the live webhook secret (a live event destination on API version `2026-09-30.endive`), `BOOKING_SWEEP_SECRET`, then `BOOKING_ALLOW_LIVE_PAYMENTS=true`, and redeploy.
3. The owner books the cheapest room, 1 night, far future, with his own Visa or Mastercard.
4. Verify Cloudbeds, the OTAs and the Stripe Dashboard. Check that **Stripe's payment receipt arrived** at the booker's email address (Stripe sends none in test mode, so this is its first real check; with `CLOUDBEDS_SEND_STATUS_EMAIL` off it is the guest's only email). Verify the GA4 `purchase` from a **non-staff** browser (owner devices never load gtag.js): **GA4 → Reports → Realtime → Event count by Event name → `purchase`** (or Tag Assistant / DebugView with debug mode on - DebugView only shows debug-mode devices). It needs `NEXT_PUBLIC_VERCEL_ENV=production` (section 2). The live preview loads gtag.js because it takes real payments.
5. Within 24 h, check **Google Ads → Goals → Conversions**: the Purchase action (GA4 import) shows the booking, with the Cloudbeds reservation id as the transaction id.
6. Refund it, following the runbook in section 8.
7. **Retract its conversion.** The refunded owner booking must not stay in conversion value and Smart Bidding: **Google Ads → Goals → Conversions → Uploads → + → Conversion adjustments**, upload a **retraction** for the Purchase action with the Stage C transaction id (the Cloudbeds reservation id) and the conversion time (or exclude that day's data). The same applies to every full refund of a real booking (section 8).

**Go/no-go:** every Stage B case passes (cases 11 and 14 answered GO), Stage C completes (receipt arrived, conversion retracted), the sweeper runs every 10 minutes (`openHolds` and `paidUnconfirmed` back to 0 after each test), the alert email arrives, **and the legal items are closed:** Owner TODO 1 resolved (`/legal` and the privacy "Who we are" name the entity that holds the Stripe account), Owner TODO 4 answered **in writing** by Stripe Thailand (surcharge allowed, and how prices must be displayed), and the GA4 unwanted referral (4.F) saved. Live payments must not be switched on (`BOOKING_ALLOW_LIVE_PAYMENTS=true`, Stage C step 2) before TODO 1 and TODO 4 are closed.

---

## 6. Cutover and rollback

1. **Soft launch.**
   - Only after the Stage C go/no-go, including the legal items (Owner TODO 1 and 4 closed in writing, 4.F referral saved).
   - Keep `BOOKING_ENGINE=cloudbeds`.
   - Run live Stripe on the unlinked `/booking-preview` for 1–2 weeks (Standard Rate only, 100% payment, no promo). These are real bookings: gtag.js loads there in stripe-live, so they reach GA4 and the Ads import.
   - Send the link to a few WhatsApp guests.
2. **Swap.**
   - Set `BOOKING_ENGINE=own` and redeploy. `/booking` then renders our engine, but only while stripe-live is fully unlocked.
   - The Cloudbeds engine moves to `/booking/classic` (noindex), linked under the page title.
   - Return URLs then use `/booking/return`; the homepage date picker becomes our own form and the "Code DIRECT" perks are replaced automatically.
   - `?promo=DIRECT` from old links is ignored, not shown as an error.
   - The "best rate when you book direct" wording leaves the `/booking` and site-wide meta descriptions and the seven language pages automatically. Do section 4.G (Google Ads) first.
   - Check after the redeploy: `/booking` shows our engine with no preview banner, `/booking/classic` loads the Cloudbeds engine, the homepage form lands on `/booking` with the dates filled in, and Lighthouse CLS on the homepage is not worse. (On phones our homepage form is taller than the Cloudbeds widget - 172 px vs 98 px - so the content below starts lower; there is no layout shift.)
3. **Run both engines for 2+ weeks.** Watch for double-counted GA4 purchases, "paid but not confirmed" alerts and holds stuck in `not_confirmed`. In Google Ads → Goals → Conversions, check that Purchase keeps receiving conversions from the GA4 import after the swap (and is not double-counted by any direct Cloudbeds Ads tag, section 4.G).
4. **Rollback.**
   - **Set `BOOKING_ENGINE=cloudbeds` and redeploy.** That is the rollback for the engine swap: the new deployment keeps the live Stripe keys, webhook, sweeper and `/booking/return`, so in-flight sessions still confirm or release their holds.
   - **Change nothing else.** Never change `BOOKING_PAYMENT_PROVIDER` or the Stripe keys as part of a rollback: keep the Stripe webhook and the sweeper running so in-flight sessions still confirm or release their holds.
   - **Avoid Vercel's "Instant Rollback" for this.** It brings back an old deployment exactly as it was built, with its own code **and its own environment variables**. A deployment from before this branch was merged has no `/api/stripe/webhook`, `/api/booking/sweep` or `/booking/return`; a Stage B deployment runs on Stripe **test** keys and the test webhook secret. Either way paid guests land on a 404 or an error page, every live webhook fails, and unpaid holds keep units off the OTAs until someone rolls forward. If you use it anyway, pick only the **last production deployment built with the same live Stripe, Cloudbeds and Redis settings** - never one from before the merge, never a Stage B one. While an instant rollback is active, Vercel does **not** put new git pushes live (e.g. content commits) until you press **"Undo Rollback"** in the Deployments view.
5. **Emergency stop.** Set `BOOKING_ALLOW_LIVE_PAYMENTS=false` and redeploy.
   - New checkouts lock at once.
   - `/booking` falls back to Cloudbeds automatically, because the own engine requires live payments to be unlocked.
   - A guest whose page was loaded before the stop and presses Pay reads "Online payment is paused - No payment was taken" with "Book on our classic booking page" as the main action and WhatsApp; both Pay buttons (in the page and the phone bar) turn into a disabled "Online payment paused", and screen readers hear "Online payment is paused. Nothing was charged." instead of the stale "taking you to Stripe". The live `/booking/return` never shows a "demo mode" note on an unverified view during the stop.
   - Bookings already paid still get confirmed, and abandoned holds still get released. The webhook, sweeper, status and abandon endpoints use `getFulfilmentConfig`, which ignores only this flag.
   - Their GA4 `purchase` is still recorded: gtag.js keeps loading on `/booking-preview/return` (the soft-launch return page) while live Stripe payments are being finished, and `/booking/return` is tracked as usual.
   - The preview's search (`/api/booking/availability`) answers 503 while payments are locked on production, so a locked page never spends the shared Cloudbeds read key.
6. **Changing the provider or the Stripe keys (drain).** A Stripe session lives 30 minutes and a delayed PromptPay payment can confirm later, so:
   1. Stop new holds: `BOOKING_ALLOW_LIVE_PAYMENTS=false` (live) or remove the test access key / unlock cookie (Stage B), and redeploy.
   2. Wait at least **1 hour**.
   3. Call the sweeper by hand and confirm it answers `"openHolds":0` and `"errors":0`.
   4. In Cloudbeds, search for reservations whose third-party id starts with `MSV-` and status "Confirmation pending"; cancel any left over by hand (none should be).
   5. Only then switch `BOOKING_PAYMENT_PROVIDER` or the keys, and redeploy.
   - Safety net if this is skipped: while the Stripe key and webhook secret are still set, the webhook, sweeper, return page and abandon endpoints keep finishing Stripe sessions even after `BOOKING_PAYMENT_PROVIDER` is switched to `beam` or `demo` (drain mode, log `stripe_drain_mode`). So **keep the Stripe variables for at least 3 days** after switching the provider. Swapping test keys for live keys cannot drain test sessions (a live key cannot read them) - hence the procedure above before Stage C.

---

## 7. Alerts

Alerts are emails to `BOOKING_ALERT_EMAIL` (default info@) in live mode, and log lines (`alert_<severity>`) otherwise (`BOOKING_ALERTS_IN_TEST=true` emails them in test mode too). They never contain guest personal data: only the ref, the Cloudbeds reservation id, dates, amounts and error codes.

Delivery (`src/lib/booking/alerts.ts`):
- Sent **after** the response (`next/server` `after()`), so a slow mail relay never delays a checkout or a webhook. Relay and SMTP fallback each get 8 s.
- Repeats of the same alert are suppressed for 6 hours **only once delivered**: a failed send logs `alert_send_failed` and frees the key, so the next occurrence tries again (a send killed mid-way frees it after 2 minutes).
- **Critical** alerts are stored in Redis before sending and removed once delivered. Every sweeper run re-sends the undelivered ones (marked "Re-sent by the booking sweeper") for up to 7 days and reports `undeliveredAlerts`. If that number stays above 0, mail is down: check the droplet relay and the Gmail app password, and read the alert in Redis (`msv:live:alerts:pending`; a test deployment's are under `msv:stripe-test:…`) or the Vercel logs.
- Claims, stored alerts and re-sends are **per mode**: a test deployment sharing the live Redis never suppresses, re-sends or clears a live alert.

| Alert | Severity | Meaning / action |
|---|---|---|
| **URGENT: paid booking … needs attention** | critical | The guest paid, but the hold was cancelled or the amounts disagree. Re-instate or re-book in Cloudbeds if the unit is free; otherwise refund (section 8) and contact the guest. |
| **Paid booking MSV-… not yet confirmed in Cloudbeds (retrying)** | warning | Payment received (the alert names the ref, the Cloudbeds reservation and the amount) and the Cloudbeds write failed. It retries automatically (Stripe for 3 days, the return page, and the sweeper with no time limit). The reservation carries a "PAID via Stripe - do NOT cancel" note. **Never cancel it.** If it repeats, check Cloudbeds, `CLOUDBEDS_STRIPE_PAYMENT_METHOD` and the key scopes. |
| **URGENT: paid booking … still not confirmed in Cloudbeds** | critical | The same, still failing 2+ hours after payment (re-sent until delivered, then every 6 hours while it lasts). Record the Stripe payment once on the folio (custom "Stripe" method) and confirm the reservation by hand, or fix the cause. Never cancel it. |
| **Reservation … carries an online-booking id we have no record of** | warning | A **confirmed** Cloudbeds reservation with an `MSV-` third-party id that the engine has no record of (staff re-booked a guest under the ref, or Redis lost it). It was NOT cancelled. Make sure the guest's payment is on its folio; cancel it only if it is an unpaid leftover. Sent once per reservation. |
| **Stopped tracking hold …** | warning | The sweeper could not release a hold for over 7 days and dropped it from its index. Check it in Cloudbeds by hand. |
| **The booking sweeper's hold index keeps growing** | warning | More than 50 holds listed as open in Redis: releases keep failing, or another mode left holds behind. Check the sweeper's answers and the logs. |
| **Booking …: the processing fee line is missing in Cloudbeds** | warning | Paid and confirmed, but `postCustomItem` failed: add the fee item by hand. If it repeats, the key lacks `write:item`. |
| **Booking stopped: Cloudbeds price differs from the quote** | warning | The hold's `grandTotal` ≠ our quote. Nothing was charged. If it repeats, check taxes or fees (WI-0 #2). |
| **Booking stopped: Cloudbeds refused the reservation** | warning | `postReservation` said no and a **fresh** availability read still shows the room free (or could not be made): a setup or data problem (required field, guestZip placeholder, rate id, payment method, scopes) that will hit every booking. The guest was told to message us. A refusal is shown as "just booked" only when the fresh read confirms the room is gone. |
| **Booking stopped: Cloudbeds returned no price for the hold** | warning | `postReservation` gave a reservation id but no readable total (and `getReservation` neither). The hold was cancelled at once; nothing was charged. If it repeats, check the key's `read:reservation` scope. |
| **Online bookings failing: Cloudbeds availability can't be read** | warning | 3+ checkouts in half an hour were refused because a Cloudbeds read (re-quote, restrictions, availability) failed. Check `CLOUDBEDS_API_KEY`, its scopes and Cloudbeds' status. Guests can still use `/booking/classic` or WhatsApp. |
| **Stay rules not checked for …** | warning | `getRatePlans` returned no rate row for a room type, so min stay / closed-to-arrival were not enforced for it (bookings still go ahead on live availability). Check that room type's rate plan in Cloudbeds. |
| **Booking stopped: Cloudbeds error on the reservation** | warning | 401/403 (key or scopes) or 429 (call budget). Nothing was created or charged. |
| **Booking interrupted: Cloudbeds reservation outcome unknown** | warning | Timeout/5xx on `postReservation`: a reservation may exist without us knowing its id. The sweeper finds it by its third-party id and cancels it after ~40 minutes; you can cancel it by hand. |
| **Booking stopped: Stripe could not create the payment page** | warning | Stripe refused the Checkout Session (the code is in the alert): restricted key permission, PromptPay not activated, account restricted. If it repeats, every online booking is failing. |
| **Hold … could not be cancelled** / **could not be released** | warning | An unpaid hold is still in Cloudbeds after a failed cancel (checkout, webhook or sweeper, once it is an hour old). It is retried; if it keeps failing, cancel it by hand. |
| **Hold … is confirmed but unpaid** | warning | Staff confirmed an unpaid online hold by hand. We did not cancel it; cancel it yourself if the guest is not paying another way. |
| **Hold … was not cancelled: the folio shows a payment** | warning | Someone added a payment to a pending hold. We refused to cancel it; check it. |
| **Hold … was not cancelled: its payments could not be read** | warning | Cloudbeds answered without any paid figure, so the sweeper/webhook refused to cancel. If nobody paid, cancel it by hand. |
| **URGENT: … PAYMENT RECORD IN DOUBT** (inside "needs attention") | critical | `postPayment` got no clear answer and the folio's paid amount can't be read. Check the folio: add the Stripe payment once if it is missing, then confirm. Never add it twice. |
| **The booking sweeper cannot read Cloudbeds reservations** | warning | 3 sweeper runs in a row could not list reservations: orphan holds are not being found or released. Check the booking key (`read:reservation`) and Cloudbeds' status. |
| **Booking attempt … no Cloudbeds reservation found** | warning | An attempt with a lost `postReservation` answer was never matched in Cloudbeds within 12 hours. Search Cloudbeds for the named third-party id and cancel it if it exists. |
| **Cloudbeds balance is not zero after payment** | warning | Confirmed, but the folio balance ≠ 0. Check taxes or rate changes. |
| **Stripe webhook: signatures are being rejected** | warning | 3+ deliveries an hour fail signature checks: usually the wrong `STRIPE_WEBHOOK_SECRET` (test secret with live keys). Bookings then only confirm through the return page and the sweeper. |
| **The booking sweeper has not run recently** | warning | Live: no sweep with a working Cloudbeds side for 30+ minutes. Check the droplet cron (4.D) and the sweeper's own answer (502 = Cloudbeds side failing). |
| **Online bookings paused: too many unpaid holds** | warning | 8 unpaid holds are open at once (abuse brake). New online bookings are refused until some expire (≤ 40 min). Repeated → consider a bot check (section 9). |
| **New direct booking … confirmed** | info | Every successful booking. |

---

## 8. Refund runbook

Neither the Cloudbeds API nor our code refunds anything. Refunds are always manual, in two systems.

1. **Stripe.**
   - Dashboard → Payments → find the payment by searching the `MSV-…` ref (it is in the description and metadata) → **Refund**, full or partial.
   - **PromptPay refunds** need the guest's bank account: Stripe emails the guest to collect it (https://docs.stripe.com/payments/promptpay).
2. **Cloudbeds.**
   - Open the reservation (Stripe metadata `msv_cb_reservation_id`) → Folio.
   - Record the refund as a **negative adjustment or refund entry** by hand. Voiding a recorded payment through the API is unreliable and not used.
   - Cancel the reservation if the stay is cancelled, so the unit goes back to the OTAs.
3. **The guest's "Payment processing fee" line.** The cancellation policy every guest agrees to (`HOUSE_POLICIES.cancellation`) says: "The payment processing fee is refunded only when the whole stay is refunded." So on a **full refund** (stay cancelled within the policy, or our fault) refund the full amount paid **including** the fee line; on a **partial refund** (e.g. 50% of the stay for a cancellation 60-90 days out) refund only the room part and keep the fee. Record the same split in the Cloudbeds folio (room refund vs fee item). If the owner decides otherwise (Owner TODO 4), change the policy text first - guests are only bound by what they agreed to.
4. **Google Ads.** After a **full** refund, retract the booking's conversion: **Google Ads → Goals → Conversions → Uploads → Conversion adjustments**, a retraction for the Purchase action with the Cloudbeds reservation id as the transaction id (for a partial refund, a restatement with the new value). Otherwise refunded bookings stay in conversion value and Smart Bidding.
5. **Currency.** Checkout Sessions pin Adaptive Pricing off, so every payment and refund is in THB. If a payment ever shows a presentment currency other than THB (Adaptive Pricing switched on for an old session, or a Stripe default change), refund it in Stripe as usual - Stripe refunds in the guest's currency at the original rate - and record the THB amount in Cloudbeds.
6. **Our own Stripe cost.** Stripe does not return its own processing fee to us on refunds. Each dispute costs ฿500, and for prepaid stays the dispute window starts on the stay date, so keep the booking evidence.

---

## 9. Known limits

- A hold blocks the unit for up to ~31 minutes if the guest walks away without pressing Cancel (Stripe's minimum session life is 30 min).
- **Hold-inventory abuse.** Every Pay creates a real Cloudbeds hold before any payment, so someone scripting checkouts with made-up details could keep units off the OTAs. Brakes in code: at most 8 open holds at once (then new checkouts are refused with an alert), at most 5 holds per guest (IP + email) and 15 per IP per 40 minutes (so guests sharing hotel Wi-Fi or a carrier's NAT don't lock each other out; a refused guest is told how long to wait and offered `/booking/classic` and WhatsApp), plus the per-instance request limiter. A determined attacker with many IPs could still block units for 40 minutes at a time; if the "too many unpaid holds" alert ever fires, add a bot check (e.g. Cloudflare Turnstile) before the hold step.
- An unclear `postReservation` answer (timeout/5xx) can leave a reservation that blocks the unit until the sweeper releases it (~40-50 minutes, aged by its intent); the guest is told to retry in a minute or message us.
- An unclear `postPayment` answer delays the confirmation by up to 10 minutes (the return page shows "Payment received - confirming"); the payment is never posted twice.
- Stays above THB 999,999.99 can't be paid online in one payment (Stripe's 8-digit limit); the guest is sent to WhatsApp before anything is reserved.
- Without a Cloudbeds confirmation email (`CLOUDBEDS_SEND_STATUS_EMAIL` off), the paid return page is the booking confirmation: right under the reference it says "Save or print this page - it is your booking confirmation" with a Print button, it lists the booking terms the guest agreed to (check-in/out, cancellation incl. the fee rule, children, the fee) and the property's address, phone and email, and it offers "Add to calendar". It can't be reopened once the tab is closed (the link's credentials live only in that tab).
- Breakfast plan and add-ons are hidden in Stripe modes, because Cloudbeds does not price them. Add a real Cloudbeds rate plan to sell them.
- Promo codes are off in Stripe modes until a code maps to a real Cloudbeds rate plan.
- Which email template `putReservation sendStatusChangeEmail=true` sends is unknown (Stage B test 12).
- Thai Stripe accounts accept Visa and Mastercard only (no Amex, JCB or UnionPay).
- In `stripe-mock` the search shows demo availability, which does not reflect mock holds.
- After a rollback to `BOOKING_ENGINE=cloudbeds`, Stripe's back link for an in-flight session lands on the Cloudbeds `/booking`, which does not call abandon: that hold is released by Stripe's 30-minute expiry (webhook) or the sweeper.
- With the default env, `/booking` and the homepage behave exactly as before, but their JavaScript is not byte-identical (a few KB of `next/dynamic` loader for the own engine), and the default deployment also has the routes `/booking/classic`, `/booking/return`, `/booking-preview`, `/booking-preview/return`, `/booking-preview/stripe-mock`, `/booking-preview/beam-demo`, `/api/stripe/webhook`, `/api/beam/webhook` and `/api/booking/{availability,checkout,status,demo-pay,sweep,abandon,mock-stripe,test-access}` (noindex, or 404/503/locked without their env vars). On the production deployment the preview is locked by default, and `/api/booking/availability` then answers 503 **without calling Cloudbeds**, so it never spends the read key shared with `/api/rates` and the droplet cron.

---

## 10. Owner TODOs (not code)

1. **Legal entity.** `/legal` names KaSem Co., Ltd. (`site.legalName`) and `/privacy` names Pakwan Samui LP as operator (`site.operatorLegalName`), both from `src/data/site.ts`. We did **not** change them. Before go-live, decide which entity holds the Stripe account and the hotel licence, and make `/legal` (and the privacy "Who we are") name the Stripe account holder - Stripe prohibits processing for an undisclosed merchant. **This is a go/no-go gate** (section 5, Stage C): note that `/legal` shows "Online payments … may be processed by Stripe" under KaSem Co., Ltd. as soon as the provider is `stripe`, so fix the entity before live payments are switched on.
2. **"Code DIRECT at checkout" copy.** Handled in code: while `BOOKING_ENGINE=own` is active, the homepage and the seven language pages show "Book direct, instantly" (translated, `OWN_ENGINE_PERK` in `src/data/landings.ts`) instead of the DIRECT perk. The "best rate when you book direct" wording also leaves the `/booking` and site-wide meta descriptions and the seven language descriptions (`descriptionForEngine`). Check the translations with a native speaker, and decide whether `/booking/classic` (where DIRECT still gives 10%) should stay linked from `/booking`, or map DIRECT to a real Cloudbeds rate plan. Before the swap, also remove "best rate" claims from the **Google Ads ad copy** (section 4.G).
3. **Cancellation/refund policy text** shown at checkout comes from `HOUSE_POLICIES` in `src/lib/booking/catalogue.ts`; confirm it is the policy you want Stripe disputes judged against.
4. **Card surcharge compliance.** The 5% "Payment processing fee" is charged on cards **and** on PromptPay. Whether Stripe's terms and the Visa/Mastercard rules allow a Thai merchant to add a card surcharge was not verified. The guest-facing wording makes no cost claim ("A 5% payment processing fee applies to online payments"), because PromptPay and domestic cards cost us far less than 5%. Before go-live, ask Stripe Thailand in writing whether a 5% card processing fee (and one on PromptPay) is permitted, at what maximum and with what wording; adjust `BOOKING_CARD_FEE_PCT` (0 switches it off) or the wording if not. Also confirm the refund policy for the fee (section 8, point 3; it is in the cancellation text guests agree to). **Price display:** the legal check must also cover **how** prices must be shown, not only whether the fee is allowed - e.g. the US FTC rule on unfair or deceptive fees (short-term lodging, 16 CFR 464) and EU price-indication / unfair-practices rules (the site has de/fr/es pages) expect mandatory fees in the first price shown. Today every room card and the results header say "+ 5% payment processing fee" next to the stay price; if the advice is to show fee-inclusive prices instead, that is a change to `RoomOfferCard`. **This is a go/no-go gate** (section 5, Stage C).
