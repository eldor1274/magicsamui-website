# Beam payments: owner checklist, routes and API notes

This file began as the notes of a **preview**: a direct booking page whose Beam (beamcheckout.com) payment created no reservation and whose webhook only logged. Since the Beam design v2 (steps S2.0-S6.1) Beam is a full **hold-first** provider like Stripe: the Cloudbeds hold first, a Beam payment link for the guest's method group, the webhook and the sweeper confirming the booking in Cloudbeds, refunds by hand.

**The runbook is `docs/booking-engine.md`**: how it works (section 1), every variable (section 2, "Beam variables"), the WI-0 script (section 3), the owner setup (4.H), the tests (section 5, "Beam: Stage A, Stage B and Stage C"), go-live and rollback (section 6), the alerts and log lines (section 7), the refunds (section 8), the limits (section 9) and the owner TODOs (section 10). This file keeps the owner's Stage B checklist, the routes and the Beam facts the code relies on, and the parts of the preview notes that are still true. Sections marked **Superseded** say where the current text is.

`beam-live` (real Beam payments) is **locked in code** (`LIVE_FULFILMENT_READY.beam = false`) until the owner-gated design step S7.1. Production keeps taking payments through Stripe.

---

## Owner checklist: Beam Stage B (plain English)

Stage B tests Beam on the Vercel **Preview** of the `beam-live` branch, with Beam's **Playground** (test money) and **real** Cloudbeds reservations. Plan about an hour for the setup and a quiet day for the tests: every test booking briefly blocks a real room on Booking.com and Airbnb. Paste keys and passwords only into Vercel, Lighthouse, Cloudbeds, the droplet's crontab or your own terminal and browser - never into this file, a chat or an email.

**What you need:** this computer with the project folder (`magicsamui-website`) and its terminal, the Vercel, Cloudbeds and Lighthouse Playground logins, SSH access to the droplet, and the Cloudbeds booking key (the key with write scopes, `CLOUDBEDS_API_KEY_BOOKING`; Vercel can't show a Sensitive value again, so take it from where you saved it - or create a new one for the Preview as in runbook 4.B step 1). Do the steps in order: later steps need what earlier ones create.

**0. GitHub: put the `beam-live` branch online under its own name**
- In a terminal in the project folder, run `git push -u origin beam-live`.
- Check: `git rev-parse --abbrev-ref beam-live@{upstream}` must print `origin/beam-live`.
- **Never push it to `main`** (no `git push origin beam-live:main`, no merge, no pull request yet): production `main` changes only at go-live (runbook section 6, item 7).
- Vercel then builds a Preview of the branch by itself (Vercel → **Deployments**, branch `beam-live`, a few minutes). Open the deployment → **Domains**: the address with `-git-beam-live-` (`https://<project>-git-beam-live-<team>.vercel.app`) is the **branch address** every later step uses. This first build has no Beam variables yet, so it may show the demo or an error page.

**1. Cloudbeds: create the Beam payment type, and pick the test date**
- Account (top right) → **Settings → Finance → Additional and Custom Payment Methods → + Add Payment Type**.
- Name it **Beam(website)** (no spaces) and keep it active. Optional, for test money only: a second one, **BeamTest(website)**.
- Run the read-only check script in the project folder's terminal (it only reads; it never changes anything in Cloudbeds). In Windows PowerShell, these three lines one after the other - the first asks for the booking key: paste it and press Enter, so the key never lands in the terminal's history:
  ```
  $env:CLOUDBEDS_API_KEY_BOOKING = Read-Host "Cloudbeds booking key"
  $env:CLOUDBEDS_PROPERTY_ID = "235064"
  node scripts/cloudbeds-wi0-check.mjs
  ```
  (in a bash terminal: `read -rsp "Cloudbeds booking key: " CLOUDBEDS_API_KEY_BOOKING; export CLOUDBEDS_API_KEY_BOOKING CLOUDBEDS_PROPERTY_ID=235064; node scripts/cloudbeds-wi0-check.mjs`). The key stays in that terminal window only (the next two bullets reuse it). PowerShell shows the key on screen while you paste it: when you are done, type `cls` and close the window.
- Its **section 6b** prints the exact value Cloudbeds gave each new type ("custom Beam method found: method value ..."). That exact value goes into `CLOUDBEDS_BEAM_PAYMENT_METHOD` in step 3 (the test type's into `CLOUDBEDS_BEAM_TEST_PAYMENT_METHOD`). Never type the name instead: Cloudbeds chooses the value. To double-check, in the same window run `$env:CLOUDBEDS_BEAM_PAYMENT_METHOD = "<that value>"` and then `node scripts/cloudbeds-wi0-check.mjs` again: section 6b must then say `EXACT` for it.
- **The test date:** test bookings must arrive **12 or more months ahead** (and within 18 months). In the same window, run `node scripts/cloudbeds-wi0-check.mjs <check-in date> 3` for a candidate date, e.g. `node scripts/cloudbeds-wi0-check.mjs 2027-11-10 3`, and keep a date where section 5 lists every room type as `available N (base row)`. Use it for every test booking (runbook section 5, Stage B setup).

**2. Beam Lighthouse Playground: the test keys**
- Sign in at **playground-lighthouse.beamcheckout.com** → **Developers**.
- Copy the **Merchant ID** and create an **API key** (step 3 needs both).
- Check that cards, e-wallets and QR PromptPay are switched on.

**3. Vercel: the Preview variables, for the `beam-live` branch only**
- Project → **Settings → Environment Variables** → add each name below with environment **Preview** only and the branch **beam-live** (never "All Preview branches": they would make real reservations from any preview). Mark the keys and secrets as Sensitive.
- What goes in each is described in words; the exact spelling of each switch is in `docs/booking-engine.md`, section 2.

| Variable name | What goes in it |
|---|---|
| `BOOKING_PAYMENT_PROVIDER` | the provider switch, set to Beam |
| `BEAM_API_BASE` | the address of Beam's Playground API (section 2, the Beam table) |
| `BEAM_MERCHANT_ID` | the Playground Merchant ID (step 2) |
| `BEAM_API_KEY` | the Playground API key (step 2) |
| `BEAM_WEBHOOK_HMAC_KEY` | the Playground webhook's HMAC key: **added in step 5**, where Lighthouse shows it |
| `CLOUDBEDS_BEAM_PAYMENT_METHOD` | the Beam(website) value the check script printed (step 1) |
| `CLOUDBEDS_BEAM_TEST_PAYMENT_METHOD` | optional: the BeamTest(website) value |
| `CLOUDBEDS_API_KEY_BOOKING` | the Cloudbeds booking key (the one with write scopes) |
| `CLOUDBEDS_PROPERTY_ID` | the Cloudbeds property id (the number in step 1's command) |
| `CLOUDBEDS_API_KEY` | the Cloudbeds read key, if Preview does not have it yet |
| `CLOUDBEDS_SOURCE_ID` | the id of the "magicsamui.com own booking page" source (the value Production has, runbook 4.B step 3) |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` (or `KV_REST_API_URL`, `KV_REST_API_TOKEN`) | the Upstash database, if the Upstash integration is not connected to Preview yet |
| `POINTS_API_URL`, `POINTS_API_SECRET` (or `CONTACT_GMAIL_USER`, `CONTACT_GMAIL_APP_PASSWORD`) | the alert mail relay, with the same values as Production, if Preview does not have them yet: without them no alert email is sent at all |
| `BOOKING_TOKEN_SECRET` | a new random secret of 32 or more characters, for Preview only |
| `BOOKING_SWEEP_SECRET` | a new random secret of 16 or more characters (letters and digits), for Preview only (the cron in step 6 uses it) |
| `BOOKING_TEST_GUEST_EMAIL` | your private test email address (never published) |
| `BOOKING_TEST_ACCESS_KEY` | a random key of 16 or more characters (you unlock your test browser with it, step 7) |
| `CLOUDBEDS_SEND_STATUS_EMAIL` | switched on, so the test address receives the Cloudbeds confirmation email |
| `BOOKING_ALERTS_IN_TEST` | switched on, so the test alerts arrive by email |
| `BOOKING_ENGINE` | optional: the own engine, to see it on the preview's `/booking` as well |

- **Do not add** `BOOKING_CARD_FEE_PCT` (it must stay unset), `BOOKING_ALLOW_LIVE_PAYMENTS`, or any live (Production) Beam key.
- Only for the drain test (runbook case B13), also on Preview for `beam-live` only: the Stripe **test** keys (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`) and the Stripe payment method for test money - recommended `CLOUDBEDS_STRIPE_TEST_PAYMENT_METHOD` with a separate Cloudbeds test type (runbook 4.B step 5), so the Stripe test payment is not recorded under the real Stripe(website) method; otherwise `CLOUDBEDS_STRIPE_PAYMENT_METHOD`, and step 10 reverses that payment.
- On the same page, check that **Automatically expose System Environment Variables** is ticked: the preview reads its own address from them (without it Beam would send you back to magicsamui.com after paying).
- Then **redeploy** the branch: Deployments → the latest `beam-live` deployment → ⋯ → Redeploy.

**4. Vercel: let Beam and the cron reach the preview**
- **Settings → Deployment Protection → Protection Bypass for Automation**: enable it and copy the secret (the **bypass secret**; steps 5-7 use it).

**5. Beam Lighthouse Playground: the webhook**
- **Developers → Webhooks → add**.
- **URL:** the branch address (step 0) + `/api/beam/webhook`, so it looks like `https://<project>-git-beam-live-<team>.vercel.app/api/beam/webhook`.
- **Events:** `payment_link.paid`, `charge.succeeded`, `charge.failed`, `refund.succeeded`, `refund.failed`, `transaction.created`.
- **Additional header:** name `x-vercel-protection-bypass`, value = the bypass secret of step 4. If Lighthouse has no field for an extra header, add the secret to the URL instead: `https://<branch address>/api/beam/webhook?x-vercel-protection-bypass=<the bypass secret>` (Vercel accepts it as a query parameter too, as step 7's link does).
- Save, copy the webhook's **HMAC key** into `BEAM_WEBHOOK_HMAC_KEY` (Vercel, as in step 3) and redeploy again.
- **Quick check** once the redeploy is ready (or ask the developer). In the project folder's terminal (in Windows PowerShell type `curl.exe`, not `curl`), with your bypass secret and branch address:
  ```
  curl.exe -sS -i -X POST -H "x-vercel-protection-bypass: <the bypass secret>" -H "content-type: application/json" -d "{}" https://<branch address>/api/beam/webhook
  ```
  It must answer **401** with the text exactly **`invalid signature`** (runbook 4.H step 6). A 401 that shows a web page (Vercel's login) means the bypass header is missing or wrong: the check did not reach the booking engine. **503 "webhook not configured"** means a Beam variable or the HMAC key is missing on that deployment (redeploy after adding it). Each check counts as one rejected signature, and the third in an hour sends the email "Beam webhook: signatures are being rejected": run it once or twice only.

**6. The droplet: a temporary sweeper cron** for the whole of Stage B
- On the droplet (SSH), run `crontab -e` and add these three lines at the end, with your two secrets in place of the `<...>` and the branch address (step 0) in the URL; the third line is the one of `docs/booking-engine.md` 4.H step 7:
  ```
  PREVIEW_SWEEP_SECRET=<the Preview's BOOKING_SWEEP_SECRET>
  VERCEL_BYPASS_SECRET=<the bypass secret>
  */10 * * * * curl -fsS -X POST -H "Authorization: Bearer $PREVIEW_SWEEP_SECRET" -H "x-vercel-protection-bypass: $VERCEL_BYPASS_SECRET" https://<branch address>/api/booking/sweep >/dev/null
  ```
  Every 10 minutes it calls the preview's sweeper, which confirms paid bookings whose webhook was lost and releases expired holds.
- Check it once by hand in the droplet's shell:
  ```
  curl -sS -X POST -H "Authorization: Bearer <the Preview's BOOKING_SWEEP_SECRET>" -H "x-vercel-protection-bypass: <the bypass secret>" https://<branch address>/api/booking/sweep
  ```
  It must print `{"ok":true,"mode":"beam-playground",...}`. `unauthorized` means a wrong sweep secret, a web page (Vercel's login) a missing bypass header, `sweeper_disabled` a Preview without `BOOKING_SWEEP_SECRET` (redeploy after adding it).

**7. Your test browser and phones**
- Always use the **branch address**: Beam sends you back after paying to the address you booked on.
- On each device, open once `https://<branch address>/booking-preview?x-vercel-set-bypass-cookie=true&x-vercel-protection-bypass=<the bypass secret>` (or a Vercel **Shareable Link** of the branch address: Vercel → the deployment → Share), so Vercel lets that browser in and Beam's redirect after paying lands on our return page, not on the Vercel login. The link leaves the bypass secret in that browser's history: step 11 rotates it.
- **Unlock test bookings** in that browser (valid 12 hours): on `https://<branch address>/booking-preview`, press F12 → Console and run the unlock command of `docs/booking-engine.md` section 5 ("Unlock this browser"), with your `BOOKING_TEST_ACCESS_KEY`; it prints `{ ok: true, validForHours: 12 }`. On a phone, use Safari's Web Inspector from a Mac or Chrome's remote debugging from a computer, or ask the developer.
- Test bookings are refused unless the browser is unlocked, the email is your test address and the arrival is on your test date (**12 or more months ahead**, step 1).

**8. Click through** (the full list with what each must show is the runbook's section 5, cases B1-B20)
- A card booking with the 3-D Secure test card **4953 2617 3050 9988** (code **123456**). If you set `CLOUDBEDS_BEAM_TEST_PAYMENT_METHOD`, do it once more with it removed (redeploy), so a payment lands under Beam(website) itself.
- A **Thai PromptPay QR** booking, and an **e-wallet** booking if the Playground offers one.
- A declined card (**4111 1111 1100 0025**), then a good one (**4111 1111 1111 1111**) on the same Beam page: one booking.
- Start a booking and press **Cancel** on Beam's page.
- Start a booking and **close the tab**; check again 40 minutes later.

**9. What to check**
- **Cloudbeds** (the reservation; open the folio with "Posted and Pending" shown): status Confirmed; Source Reservation ID ending in `-B-TEST`; source "magicsamui.com own booking page"; the payment under the Beam test type (or **Beam(website)** when there is no test type) - **not** under Stripe (website); for card or e-wallet one "TEST - Payment processing fee" line (3%), for PromptPay no fee line; balance 0; a note "TEST MODE - NOT REAL MONEY. PAID via Beam ..." naming the method and its refund path; the Cloudbeds confirmation email in your test inbox.
- **Cancelled or closed bookings:** the reservation is Cancelled and the room is back on sale.
- **Beam Lighthouse Playground:** Payments shows the link PAID with its charge SUCCEEDED (DISABLED after Cancel, EXPIRED or DISABLED after the closed tab); Developers → Webhooks shows the deliveries answered 200.
- **Email:** the alerts, e.g. "New direct booking ... confirmed" (their subjects start with `[beam-playground]`), with no guest names or emails in them.

**10. Clean up each paid test booking** (Cloudbeds): reverse the test payment - the Beam payment, or the Stripe test payment of the drain test (B13) - with one refund/adjustment entry for the same amount (if you refunded it in Lighthouse and recorded that refund on the folio, that entry is the reversal: don't add a second), remove or void the "TEST - Payment processing fee" line (card and e-wallet bookings), then cancel the reservation. Write the reservation id and date in the Stage B log (runbook section 5).

**11. Afterwards: remove the test setup**
- Run the hand check of step 6 once more (or ask the developer): every entry of `runs` in its answer shows `"openHolds":0`, `"paidUnconfirmed":0` and `"errors":0`.
- Vercel → Settings → Environment Variables (Preview, `beam-live`): **delete `BOOKING_TEST_ACCESS_KEY` and `BOOKING_TEST_GUEST_EMAIL`**.
- If you ran the drain test (B13): also delete `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and `CLOUDBEDS_STRIPE_TEST_PAYMENT_METHOD` (or `CLOUDBEDS_STRIPE_PAYMENT_METHOD`) from Preview (`beam-live`), and check that `BOOKING_PAYMENT_PROVIDER` is back to Beam.
- When you are done with the preview altogether (wait 7 days first if late test payments should still be reported): delete the rest of the Preview (`beam-live`) variables of step 3 - the Beam Playground variables, `CLOUDBEDS_API_KEY_BOOKING`, `BOOKING_TOKEN_SECRET`, `BOOKING_SWEEP_SECRET`, `BOOKING_ALERTS_IN_TEST` and any Preview copies of the mail relay - disable the Playground webhook in Lighthouse, and deactivate BeamTest(website) in Cloudbeds if you created it.
- Vercel → Settings → Deployment Protection: **rotate or disable** Protection Bypass for Automation (the old secret was in the test browsers' address bars and in the cron).
- The droplet: **remove the preview cron line** and its two value lines.
- Each test browser: remove the unlock cookie (the `DELETE` command in runbook section 5) or let it expire after 12 hours.
- Redeploy the branch.

---

## Routes

| Route | What it is |
|---|---|
| `/booking-preview` | The booking app (noindex): search → results → guest details → payment (Beam and Stripe: no add-ons step). Accepts `?checkin=YYYY-MM-DD&checkout=…&adults=N&promo=CODE&theme=classic`. Beam's Cancel button lands here with `?resume=payment&reason=cancelled&ref&t`. |
| `/booking-preview/return?ref=…&t=…` | Confirmation and payment-status page (Beam's `redirectUrl`; the demo adds `&p=…`). |
| `/booking`, `/booking/return` | The same pages once `BOOKING_ENGINE=own` is active (section 1 of the runbook). |
| `/booking-preview/beam-demo?t=…` | The SIMULATED Beam page. It exists only in the demo and answers 404 in every other mode. |
| `POST /api/booking/checkout` | Server re-quote, then (Beam) the Cloudbeds hold and a Beam payment link for the chosen `payMethod`. |
| `GET /api/booking/status` | The return page's check: verifies the token, reads the link and its charges from Beam, confirms a paid booking in Cloudbeds. |
| `POST /api/booking/abandon` | Cancel/Back: disables the link and releases the hold (a paid one is confirmed instead). |
| `POST /api/beam/webhook` | Beam's webhook: signature over the raw body, then fulfil (below). |
| `GET/POST /api/booking/sweep` | The sweeper (Bearer `BOOKING_SWEEP_SECRET`), every configured provider. |
| `POST /api/booking/demo-pay` | Demo only: the simulated page's outcome (never card data). |
| `POST/DELETE /api/booking/test-access` | Stage B: sets (POST, 404 unless the test guard is active) or clears (DELETE) the browser's unlock cookie. |

The pages are `noindex, nofollow`, not in the sitemap, and nothing on the site links to `/booking-preview`.

## How a Beam booking flows

```
Browser (BookingApp, client state in sessionStorage)
  GET  /api/booking/availability   ─► Cloudbeds getAvailableRoomTypes (read-only) | demo calendar
  POST /api/booking/checkout       ─► validate, re-quote with the group's fee, test guard, brakes
                                       ├─ demo: signed token ─► /booking-preview/beam-demo
                                       └─ beam: Cloudbeds hold ({ref}-B[-TEST]) ─► folio read-back ─►
                                                POST /api/v1/payment-links (one method group, 30 min,
                                                signed PII-free note) ─► record + links-open ─► redirect to Beam
  Beam hosted page ─► /booking-preview/return?ref&t          (Cancel ─► /booking-preview?resume=payment&...)
  GET  /api/booking/status         ─► verify token ─► GET payment link + its charges ─► fulfil if paid
  POST /api/booking/abandon        ─► disable the link ─► release the hold (paid: fulfil instead)
  POST /api/booking/demo-pay       ─► demo only: {t, outcome} ─► signed proof (never card data)
  POST /api/beam/webhook           ─► finishes Beam payments through the active Beam config or the Beam drain
  /api/booking/sweep (cron)        ─► Beam's charge scan, open links, late watch; releases expired holds
```

`POST /api/beam/webhook` (design S4.4/S4.7):
- It finishes Beam payments through the active Beam config or, after a switch away from Beam, the Beam drain.
- **503 before the body is read** when there are no Beam deps (log `beam_webhook_unconfigured`, with no data) or no `BEAM_WEBHOOK_HMAC_KEY` (`beam_webhook_unconfigured {hmacKey: false}`); Beam retries every non-2xx answer.
- **401** for a missing or bad `X-Beam-Signature` (HMAC-SHA256 over the exact raw body with the base64-decoded key; the 3rd in an hour alerts the owner).
- **413** over 64 KB (a capped read: the body is never buffered whole first).
- Every Beam call of a delivery is bounded by 25 s, inside `maxDuration` 30 (runtime `nodejs`); the work runs inline, not after the response.
- The event comes from the body's ids (a link, a payment-link charge, a refund or a transaction); every payment is re-read from Beam. A paid link: the paid marker and the paid-but-unconfirmed entry are written first (503 only if that fails), then fulfil; 200 whatever fulfil does next (the sweeper retries).
- Register these Lighthouse events: `payment_link.paid`, `charge.succeeded`, `charge.failed`, `refund.succeeded`, `refund.failed`, `transaction.created`.

### Code layout

- `src/lib/booking/`: pure TypeScript.
  - Imports are relative with `.ts` extensions and use only erasable syntax, so `node --test src/lib/booking` runs it directly on Node 24.
  - `index.js` is the test entry, and the `*.test.ts` files sit next to the modules they test.
  - Shared modules: `types.ts` (contracts), `config.ts` (modes and variables), `dates.ts`, `catalogue.ts` (rooms, units, plans, policies), `quote.ts` (integer-satang pricing, the fee per method), `demoProvider.ts` and `cloudbedsProvider.ts` (the two data sources), `availability.ts`, `validate.ts`, `checkout.ts`, `status.ts`, `abandon.ts`, `demoPay.ts`, `token.ts`, `urls.ts`, `guest.ts`, `clientAnalytics.ts`, `apiClient.ts`, `routeUtils.ts`, `theme.ts`, `paymentCopy.ts`, `returnView.ts`.
  - The hold-first core, shared with Stripe: `holdFirstCheckout.ts`, `checkoutShared.ts`, `fulfil.ts`, `sweep.ts`, `sweepProviders.ts`, `lock.ts`, `alerts.ts`, `runtime.ts`, `routeFallback.ts`, `providerDispatch.ts`, `payments/gateway.ts`.
  - Beam: `beam.ts` (the API client and HMAC), `beamCheckout.ts`, `beamWebhook.ts`, `payments/beamCheckoutAdapter.ts`, `payments/beamGateway.ts`, `payments/beamState.ts`, `payments/beamRecord.ts`, `payments/beamText.ts`, `payments/beamIds.ts`, `mock/fakeBeam.ts` and `beamTestkit.ts` (tests), `demoCards.ts` (the simulated page's test cards).
- `src/data/cloudbeds.ts`: the room type ID ↔ slug map. It is shared with `/api/rates`, which behaves exactly as before.
- `src/components/booking/`: client UI.
  - `BookingApp.tsx` and `state.ts` hold the reducer, context, persistence and step machine.
  - `booking.css` holds the theme tokens.
  - Each other file names its OWNER at the top.

### Repository notes

- `tsconfig.json` has `allowImportingTsExtensions: true` so `src/lib/booking` can use `.ts` import specifiers that Node 24 runs directly under `node --test`. It is harmless with `noEmit` (and Next/Turbopack resolve these specifiers).
- `src/lib/booking/index.js` is the test entry. It is ESM with top-level await in a package without `"type": "module"`, so it relies on Node 22.12+/24 module-syntax detection. It cannot be renamed to `index.mjs` because `node --test <dir>` resolves a directory through `index.js`.
- The Cloudbeds provider reads from API **v1.3** (identical read endpoints to v1.2, which `/api/rates` still uses).

### Tokens and the payment key

The facts needed after the payment redirect travel in an HMAC-SHA256-signed token (`BOOKING_TOKEN_SECRET`): the ref, the payment mode, the dates, the items and their room totals, the amounts, the link's expiry, the theme and, on Beam, the method group (`payMethod`). Tokens never contain a name, email or phone, because they appear in URLs. They are also validated by shape after the signature check (`isBookingSummary` in `token.ts`), so a token can never put arbitrary text on our pages.

The Beam payment-link id is only known after the redirect URLs have been built, so the checkout answer also returns a `linkToken` carrying it. The browser keeps it in sessionStorage and the return page sends it to `/api/booking/status` as `l`. Without it (a new tab, the server render of the return page), status finds the link through the booking's pointer in Redis (`msv:booking:{ref}`, written at checkout). With the link, status reads `GET /api/v1/payment-links/{id}` **and** `GET /api/v1/charges?source_in=PAYMENT_LINK&sourceId={id}`; the state comes from both (`beamPaymentState`, runbook "Guarantees with Beam"). The preview's old fallback by `referenceId` alone is gone (design S4.6).

## Modes (superseded)

Superseded by `docs/booking-engine.md` section 1 ("Providers and modes", "Beam live conditions") and section 2. In short: `demo` (the default), `beam-playground` (`BOOKING_PAYMENT_PROVIDER=beam`, the Playground base and both keys; real Cloudbeds holds with `CLOUDBEDS_API_KEY_BOOKING`, the fake Cloudbeds locally without it) and `beam-live` (the live base and every Beam live condition, one of them the code switch `LIVE_FULFILMENT_READY.beam`, which is `false`). Still true from the preview: a live base with a condition missing is refused (`live_payments_locked`), an unrecognised base is `invalid_beam_base`, a strong `BOOKING_TOKEN_SECRET` (32+ random characters) is required in the Beam modes and on every Vercel deployment, and in a Beam mode a failed Cloudbeds read is never replaced by demo data (503, nothing charged). No longer true: "no reservation is created", "the webhook only logs", "guest details never leave the browser" and "promos are demo-only" (Beam pages sell Cloudbeds' own codes and discounts, as Stripe pages do).

| dataSource | When |
|---|---|
| `cloudbeds` | `CLOUDBEDS_API_KEY` (or the booking key) is set and `BOOKING_DATA_SOURCE` is not `demo`. |
| `demo` | Otherwise. A deterministic calendar with about 35% of unit-nights booked, busier at weekends and in high season. Real Cloudbeds writes refuse it. |
| `demo-fallback` | A Cloudbeds call failed in the demo (or stripe-mock). The response uses demo data and the banner says so. Never in a Beam mode, stripe-test or stripe-live (503 instead). |

## The demo (simulated Beam page)

With no payment variables the page runs as a **demo**: no card is charged, no reservation is created, and no booking or ecommerce event reaches GA4 or Google Ads (the site-wide tags of `layout.tsx` still load on `/booking-preview*` in the demo, see Analytics). Pay opens `/booking-preview/beam-demo`, a simulated Beam page with Beam's Playground test cards (`demoCards.ts`, checked in the browser only); its outcome comes back as a signed proof from `/api/booking/demo-pay`. The demo keeps its own words and badges, its 3% fee, its site-side DIRECT discount (`BOOKING_DEMO_PROMO_PCT`, default 10%), the deposit setting (`BOOKING_DEPOSIT_PCT`) and the Breakfast plan and add-on (below). `BOOKING_PAYMENT_PROVIDER=beam` without Beam keys is the demo too (locally; a config error on production or next to a Cloudbeds booking key).

## Money and pricing

- All arithmetic is in **integer satang**. Each derived amount is rounded half-up once. Amounts are displayed like Cloudbeds (`18,750.00`), with a `THB` prefix on totals.
- **Beam modes** (as Stripe's): the Standard rate only (Cloudbeds' base rate, the Direct rate for DIRECT, another code's plan, the automatic discounts), no add-ons, 100% up front. The fee depends on the guest's choice: "Card or e-wallet" 3% (`BOOKING_CARD_FEE_PCT`, unset = 3 on Beam), "Thai PromptPay QR" none (`BEAM_PROMPTPAY_FEE_PCT`, default 0), labelled "Payment processing fee (3%)" and left out at 0. The Beam link's `order.netAmount` is the total for that method, and the link offers only that method group, so a fee by method is possible (one link per group).
- **The demo:** nightly rate = the `rooms.ts` priceThb, ×1.3 in high season (20 Dec–10 Jan and 1 Jul–31 Aug), ×1.1 on Friday and Saturday nights, rounded to whole baht. Rate plans: **Standard Rate** and **Breakfast** (+1,000 THB per guest per night). Add-on "Breakfast per person": 1,000 THB per guest per eligible night (Wednesday, Thursday and Friday nights), Standard Rate only. Promo `DIRECT` (any case) gives `BOOKING_DEMO_PROMO_PCT`% off the room subtotal. The fee is 3% of (rooms + add-ons − promo). Deposit: `BOOKING_DEPOSIT_PCT`% of the total, shown as "Due now".
- At checkout the server **always re-quotes** from the cart's identifiers only (slug, plan, dates, adults, add-ons, code; on Beam the method group). The browser sends `expectedTotalSatang` and `expectedDueNowSatang` only so the server can answer `price_changed` with the new quote when either differs (e.g. a provider switch changed the fee). Any other price field in the request is ignored.
- Occupancy (Cloudbeds data): search asks `getAvailableRoomTypes` with `adults=1` so every room type is listed, reads each room's `adultsIncluded` / `adultsExtraCharge`, and checkout prices from **the same `adults=1` answer** (fresh), asking once per party size only as an **availability gate** (log `cloudbeds_occupancy_rate_differs` when the two rates differ). Search answers are cached for 60 s per server instance, and every preview call to Cloudbeds draws on a per-instance budget (`CLOUDBEDS_PREVIEW_BUDGET` in `cloudbedsProvider.ts`: about 3 calls/s, burst 8).
- JSON request bodies (checkout, abandon, demo-pay, test-access): `application/json` only (415 otherwise), read through a capped stream (413 over 16 KB for checkout, 8 KB for abandon, 4 KB for demo-pay, 1 KB for test-access), never buffered whole first. The Beam webhook reads its raw body capped at 64 KB.
- Checkout validation covers the dates (1–30 nights, an 18-month window), adults per room, bookable slugs only, no two items sharing a physical unit, the plan rules and availability at that moment; Beam also the method group (400 "Please choose how to pay").

## Physical units

`HM` honeymoon, `SR` sunrise, `GS` garden, `SVL` seaview level, `TUX` Tuxedo villa, `TUXL` Tuxedo lower unit.

The combination room types occupy several units:

- tower-club-3br = HM + SVL
- island-view-3br = SVL + SR
- magic-1-villa = HM + SR + GS + SVL
- tuxedo / tuxedo-1br = TUX

A room type is available only if every one of its units is free on every night of the stay. The cart blocks combinations that share a unit, and checkouts lock every physical unit while they hold.

tuxedo-3br has no Cloudbeds room type, so it is shown as "Enquire on WhatsApp".

## Analytics

`clientAnalytics.ts` sends Cloudbeds-compatible GA4 ecommerce events: `add_to_cart`, `remove_from_cart`, `begin_checkout`, `add_payment_info` (on Beam with `payment_type` `card_or_ewallet` or `promptpay`) and `purchase` (once per ref).

Events reach `dataLayer`/gtag **only** in a live mode (`beam-live` or `stripe-live`) with `NEXT_PUBLIC_VERCEL_ENV` `production`; everywhere else they go to `window.__bookingEvents` and `console.debug`. `purchase` is sent only after the server reports the booking paid **and** confirmed in Cloudbeds (its reservation id is the `transaction_id`). In a live mode the per-tab purchase guard is set from gtag's `event_callback`, i.e. only once gtag.js has really sent the event; within one page load an in-memory guard stops duplicates.

No personal data is ever included. Payloads match Cloudbeds': every event carries `property_id` ("235064"), `item_name` is the Cloudbeds room type name (`CLOUDBEDS_ROOM_NAMES` in `src/data/cloudbeds.ts`), and `begin_checkout` / `purchase` carry `subtotal` (the total before the fee). The preview has its own copy of the "Having trouble paying?" strip (`BookingHelp.tsx`) whose `booking_help_*` events go through the same gate.

On `/booking-preview*` gtag.js loads only while the deployment takes real payments (stripe-live or beam-live on production), and on the return page also while live payments are only being finished; the site-wide WhatsApp button sends no `whatsapp_fab_click` there otherwise. Personal data shown or typed on screen (the guest details form, the lead guest on the payment review, the simulated card form) carries `data-clarity-mask`, and Clarity never records `/booking-preview*`.

Not built (runbook section 9): a server-side `purchase` through the GA4 Measurement Protocol from the verified webhook.

## Safety checklist

- Card data never touches our servers. Beam hosts the real form; the demo page checks test card numbers in the browser only; `/api/booking/demo-pay` rejects any field except `t` and `outcome`. The last four card digits Beam sends back are dropped when a charge is read (`parseBeamCharge`), so they are never logged or stored.
- Beam gets the booking reference, what was booked (rooms, dates, nights, guests), the amounts and our signed note - never the guest's name, email address or phone number (`collectPhoneNumber` false).
- Redirect and return URLs are built from an allow-list of hosts: magicsamui.com, www, this deployment's own `*.vercel.app` URLs (plus, optionally, hosts ending in `-<BOOKING_VERCEL_TEAM_SLUG>.vercel.app`), and localhost:3000 off Vercel only. A project-name prefix alone is not trusted. The Host header is never trusted as-is.
- The browser follows only same-origin redirects or https redirects to the payment hosts (`isAllowedPaymentRedirect`: `checkout.stripe.com`, `pay.beamcheckout.com`, `playground-pay.beamcheckout.com`); the server accepts a Beam link only on the hosted host of its own API base.
- Bearer tokens out of analytics: the return page and the simulated Beam page move `t` / `p` / `ref` from the address bar into this tab's sessionStorage on mount and clean the address bar with `history.replaceState` before gtag.js and Clarity load. The cleanup is an **allow-list** (`allowListedSearch` in `urls.ts`: `theme`, the `staff` flag, ad-click ids, `utm_*`), so anything Beam might append to `redirectUrl` / `cancelUrl` is dropped too. In GA4, redact `t`, `l`, `p` and `ref` as well (runbook 4.H step 9).
- Webhook verification: HMAC-SHA256 over the exact raw body with the base64-decoded key, tested against Beam's published test vector; the event is decided from the body's ids, and every payment is re-read from Beam before anything is done.
- The simulated Beam page renders without the site header, footer and WhatsApp button, like a real hosted checkout. The Cloudbeds bundle is not loaded on `/booking-preview`.
- The chosen theme survives the Beam round trip (in the signed token and as `&theme=classic` on the return and cancel URLs); the `?checkin/?checkout/?adults/?promo` prefill is applied once and then removed from the address bar, and a hash of the one-shot parameters (`landingKey`) stops a replayed landing being applied twice.
- Browser history: each forward step pushes an entry; the in-app back arrow and Edit links return to the existing entry, so the browser / Android Back button keeps going back; a back/forward-cache restore re-reads the saved booking, so a cart cleared after payment can't be paid twice.

## Go-live checklist (superseded)

Superseded by `docs/booking-engine.md`: the owner setup (4.H), Beam Stage A/B/C (section 5), Beam go-live and rollback (section 6, items 7-11) and the owner TODOs (section 10, item 7). Everything the preview's list asked for is built: the hold-first `postReservation` with the guest's details, the custom Cloudbeds method (`Beam(website)`, `CLOUDBEDS_BEAM_PAYMENT_METHOD`), fulfilment from the verified webhook and the return page, the disable on Cancel, the sweeper (expiry, late payments), a stable idempotent fulfilment on Redis, the fee per method (a Card / PromptPay choice with a method-specific link and the fee on cards and e-wallets only), the updated `/privacy` and `/legal`, and the Beam lines of the GA4 setup. Still open: S7.1 (the code switch, owner-gated) and the owner's questions to Beam (below).

## Beam API facts the code relies on

From Beam's docs and OpenAPI 1.25.0, read on 21 Oct 2026 (the full notes: `beamApi` in the design's `beam-design.json`):
- Bases `https://playground.api.beamcheckout.com` and `https://api.beamcheckout.com`, fully separate (keys, webhooks, HMAC keys, data). HTTP Basic `base64(merchantId:apiKey)`; Beam reads the merchant from the key.
- Payment Links are Beam's only hosted checkout: one fixed `netAmount` in satang (at least 100), `linkSettings` replacing the account's method defaults, `x-beam-idempotency-key`, 201 `{id, url}`. Link statuses ACTIVE, DISABLED, EXPIRED, PAID, VOIDED, REFUNDED; `PATCH /api/v1/payment-links/{id}/disable`.
- Charges PENDING, SUCCEEDED, FAILED; a declined attempt leaves the link ACTIVE (each attempt a new charge). A charge can stay PENDING for long and "a very late charge.succeeded webhook is still possible" (PromptPay bank confirmations, slip verification), and Beam sends **no** expiry event: hence the sweeper's charge scan and late watch.
- Refunds `POST/GET /api/v1/refunds`: only CARD, CARD_INSTALLMENTS, QR_PROMPT_PAY, ALIPAY and WECHAT_PAY, in part only CARD, paid from the available balance. The booking engine never creates a refund (owner decision: refunds by hand).
- Webhooks: `X-Beam-Signature` = base64 HMAC-SHA256 over the raw body; no event id, no timestamp, no documented IP list; any 2xx is success, anything else is retried up to 10 times; at least once and possibly out of order. `payment_link.paid` carries no charge id (the charge list has it).
- Transactions PAYMENT, REFUND, VOID and CHARGEBACK (the last only in the OpenAPI enum), with the fee, VAT and net amounts.

## Open questions

The current list is `openQuestionsForBeam` and `openQuestionsForOwner` in `beam-design-v2.json` (21 questions for Beam; the surcharge, question 1, and the legal entity, question 17, are go-live gates; runbook section 10). The preview's own questions are answered or superseded: the hosted page, the refund methods and the webhook facts are in the section above; the Cloudbeds questions (`roomRate` per stay, `postReservation` fields, `not_confirmed` blocking OTA inventory, zero availability, combinations, the tuxedo-3br id, the payment method value) are tracked in the runbook's section 3 (WI-0) and Stage B. Still open from the preview: whether Apple Pay and Google Pay come with Beam's card method, whether the hosted page can carry our logo, and the occupancy-pricing question (`adultsExtraCharge` per stay or per night: the log line `cloudbeds_occupancy_rate_differs` answers it from real checkouts).

## Intentional differences from the Cloudbeds engine

- No "Accommodation types" **Filters** control: with 11 room types (12 cards) the list is short enough without it.
- The processing fee is shown as its own line with a visible explanation (Cloudbeds hides it in a suppressed tooltip); on Beam it depends on the method the guest chooses.
- The `classic` theme uses Poppins (as Cloudbeds) through `next/font`, not preloaded, so the default `magic` theme never downloads it.

## Commands

```
npx tsc --noEmit
npm run lint
node --test src/lib/booking          # or: node --test "src/lib/booking/*.test.ts"
npm run build
```
