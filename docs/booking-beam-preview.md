# Own booking engine with Beam payments: preview

This is a preview of a direct booking page that looks and flows like the Cloudbeds immersive engine, but takes payment through Beam (beamcheckout.com) instead of Cloudbeds.

It runs in **demo mode** by default. In demo mode:

- No card is charged.
- No reservation is created.
- Nothing reaches GA4 or Google Ads.

The live `/booking` page (Cloudbeds) is untouched.

| Route | What it is |
|---|---|
| `/booking-preview` | The booking app: search → results → add-ons → guest details → payment. Accepts `?checkin=YYYY-MM-DD&checkout=…&adults=N&promo=CODE&theme=classic`. |
| `/booking-preview/beam-demo?t=…` | A SIMULATED Beam hosted checkout. It exists only in demo mode and returns 404 in every other mode. |
| `/booking-preview/return?ref=…&t=…[&p=…]` | Confirmation and payment-status page. |

The pages are `noindex, nofollow`. They are not in the sitemap and nothing on the site links to them.

## Architecture

```
Browser (BookingApp, client state in sessionStorage)
  GET  /api/booking/availability   ─► demo calendar  |  Cloudbeds getAvailableRoomTypes (read-only)
  POST /api/booking/checkout       ─► server re-quote ─► booking ref + signed token
                                       ├─ demo:  redirect to /booking-preview/beam-demo
                                       └─ beam:  POST /api/v1/payment-links ─► redirect to Beam hosted page
  Beam / demo page ─► /booking-preview/return?ref&t[&p]
  GET  /api/booking/status         ─► verify token ─► demo proof | Beam GET payment-link (or charges by ref)
  POST /api/booking/demo-pay       ─► demo only: {t, outcome} ─► signed proof (never card data)
  POST /api/beam/webhook           ─► HMAC verify (raw body) ─► 200 + PII-free log (no fulfilment in preview)
```

### Code layout

- `src/lib/booking/`: pure TypeScript.
  - Imports are relative with `.ts` extensions and use only erasable syntax, so `node --test src/lib/booking` runs it directly on Node 24.
  - `index.js` is the test entry, and the `*.test.ts` files sit next to the modules they test.
  - Modules:
    - `types.ts`: all contracts.
    - `config.ts`: modes and environment variables.
    - `dates.ts`: Asia/Bangkok date helpers.
    - `catalogue.ts`: rooms, physical units, rate plans, add-ons and policies.
    - `quote.ts`: integer-satang pricing.
    - `demoProvider.ts` and `cloudbedsProvider.ts`: the two data sources.
    - `availability.ts`
    - `validate.ts`
    - `checkout.ts`, `status.ts` and `demoPay.ts`: orchestration.
    - `beam.ts`: Beam client and HMAC.
    - `token.ts`: signed tokens, booking refs and idempotency keys.
    - `urls.ts`: allow-listed redirect origins.
    - `guest.ts`: guest form model and validation.
    - `demoCards.ts`: Beam test cards.
    - `clientAnalytics.ts`: gated GA4 events.
    - `apiClient.ts`: browser fetch wrappers.
    - `routeUtils.ts`
    - `theme.ts`
- `src/data/cloudbeds.ts`: the room type ID ↔ slug map. It is shared with `/api/rates`, which behaves exactly as before.
- `src/components/booking/`: client UI.
  - `BookingApp.tsx` and `state.ts` hold the reducer, context, persistence and step machine.
  - `booking.css` holds the theme tokens.
  - Each other file names its OWNER at the top.

### Why stateless tokens

The project has no database. The facts needed after the payment redirect travel in an HMAC-SHA256-signed token (`BOOKING_TOKEN_SECRET`): ref, dates, items, amounts, link expiry and payment mode.

Tokens never contain a name, email or phone, because they appear in URLs.

The Beam payment-link id is only known after the redirect URLs have been built. The checkout response therefore also returns a `linkToken` that carries the id. The browser stores it in sessionStorage, and the return page sends it to `/api/booking/status` as `l`. Without it, status falls back to `GET /api/v1/charges?referenceId=…&source_in=PAYMENT_LINK`.

## Modes

`config.ts` derives everything from environment variables. Secrets are only read in server code and never use `NEXT_PUBLIC_`.

| paymentMode | When | What happens |
|---|---|---|
| `demo` (default) | Anything that isn't the two rows below | Simulated Beam page. Built-in demo token secret allowed. |
| `beam-playground` | `BEAM_MERCHANT_ID` + `BEAM_API_KEY` set **and** `BEAM_API_BASE=https://playground.api.beamcheckout.com` | Real Beam sandbox payment links. Test cards only. |
| `beam-live` | `BEAM_API_BASE=https://api.beamcheckout.com` **and** `BOOKING_ALLOW_LIVE_PAYMENTS=true` **and** `VERCEL_ENV=production` (and keys) | Real charges. |

How bad settings are handled:

- If `BEAM_API_BASE` points at the live API but any of the live conditions is missing, the configuration is **refused**. Checkout and status answer `503 live_payments_locked`, and the page banner shows the lock. Live mode is never used silently.
- An unrecognised `BEAM_API_BASE` is refused in the same way.
- Both `beam-*` modes need `BOOKING_TOKEN_SECRET` of at least 32 characters.

| dataSource | When |
|---|---|
| `cloudbeds` | `CLOUDBEDS_API_KEY` is set and `BOOKING_DATA_SOURCE` is not `demo`. Uses the existing read-only key. |
| `demo` | Otherwise. A deterministic calendar with about 35% of unit-nights booked, busier at weekends and in high season. |
| `demo-fallback` | A Cloudbeds call failed. The response uses demo data and the banner says so. |

### Environment variables

| Name | Default | Notes |
|---|---|---|
| `BEAM_API_BASE` | unset | Playground or live base URL. |
| `BEAM_MERCHANT_ID`, `BEAM_API_KEY` | unset | From Lighthouse > Developers. Playground and live keys differ. |
| `BEAM_WEBHOOK_HMAC_KEY` | unset | Base64 HMAC key of the Lighthouse webhook. When unset, the webhook answers 503. |
| `BOOKING_TOKEN_SECRET` | demo built-in | 32+ random characters. **Required** in beam-* modes. |
| `BOOKING_ALLOW_LIVE_PAYMENTS` | unset | Must be exactly `true` for live mode. |
| `BOOKING_DATA_SOURCE` | unset | Set it to `demo` to force simulated availability even when a Cloudbeds key exists. |
| `CLOUDBEDS_API_KEY` | existing | Read-only use. |
| `CLOUDBEDS_PROPERTY_ID` | unset | Optional. Sends `propertyIDs` to Cloudbeds. |
| `BOOKING_CARD_FEE_PCT` | 5 | Card processing fee, shown visibly. Clamped 0–10. |
| `BOOKING_DEPOSIT_PCT` | 100 | Share of the total due now. Clamped 1–100. |
| `BOOKING_DEMO_PROMO_PCT` | 10 | `DIRECT` discount on the room subtotal. Clamped 0–50. |
| `BOOKING_VERCEL_PROJECT` | magicsamui-website | Prefix of allowed `*.vercel.app` hosts. |

## Money and pricing

- All arithmetic is in **integer satang**. Each derived amount is rounded half-up once.
- Amounts are displayed like Cloudbeds (`18,750.00`), with a `THB` prefix on totals.
- Demo nightly rate: the `rooms.ts` priceThb, ×1.3 in high season (20 Dec–10 Jan and 1 Jul–31 Aug), ×1.1 on Friday and Saturday nights, rounded to whole baht.
- Rate plans:
  - **Standard Rate**
  - **Breakfast**: +1,000 THB per guest per night.
- Add-on "Breakfast per person": 1,000 THB per guest per eligible night, on Wednesday, Thursday and Friday nights only. It can only be added to the Standard Rate.
- Promo `DIRECT` (any case) gives `BOOKING_DEMO_PROMO_PCT`% off the room subtotal. Unknown codes get a friendly error.
- Card processing fee: `BOOKING_CARD_FEE_PCT`% of (rooms + add-ons − promo). It is shown **visibly**; Cloudbeds currently hides its 5% fee.
- Deposit: `BOOKING_DEPOSIT_PCT`% of the total, shown as "Due now". The Beam `order.netAmount` is this amount.
- At checkout the server **always re-quotes** from (slug, ratePlanId, dates, adults, add-ons, promo). The browser sends `expectedTotalSatang` only so the server can answer `price_changed` with the new quote. Any other price field in the request is ignored.
- Checkout validation covers:
  - dates in range
  - 1–30 nights
  - booking window of 18 months
  - adults 1..room maximum
  - bookable slugs only
  - no two items sharing a physical unit
  - add-on/rate-plan rules
  - availability at that moment

## Physical units

`HM` honeymoon, `SR` sunrise, `GS` garden, `SVL` seaview level, `TUX` Tuxedo villa, `TUXL` Tuxedo lower unit.

The combination room types occupy several units:

- tower-club-3br = HM + SVL
- island-view-3br = SVL + SR
- magic-1-villa = HM + SR + GS + SVL
- tuxedo / tuxedo-1br = TUX

A room type is available only if every one of its units is free on every night of the stay. The cart blocks combinations that share a unit.

tuxedo-3br has no Cloudbeds room type, so it is shown as "Enquire on WhatsApp".

## Analytics

`clientAnalytics.ts` sends Cloudbeds-compatible GA4 ecommerce events: `add_to_cart`, `remove_from_cart`, `begin_checkout`, `add_payment_info` and `purchase` (once per ref).

Events are sent to `dataLayer`/gtag **only** when paymentMode is `beam-live` and `NEXT_PUBLIC_VERCEL_ENV` is `production`. Everywhere else they go to `window.__bookingEvents` and `console.debug`.

No personal data is ever included.

## Safety checklist (preview)

- Card data never touches our servers.
  - Beam hosts the real form.
  - The demo page checks test card numbers in the browser only.
  - `/api/booking/demo-pay` rejects any field except `t` and `outcome`.
- Redirect and return URLs are built from an allow-list of hosts: magicsamui.com, www, this project's `*.vercel.app` hosts, and localhost:3000 off Vercel only. The Host header is never trusted as-is.
- The browser follows only same-origin redirects or redirects to `pay.beamcheckout.com` / `playground-pay.beamcheckout.com`.
- Webhook verification:
  - It uses HMAC-SHA256 over the exact raw body, with the base64-decoded key.
  - It is tested against Beam's published test vector.
  - The preview only logs a PII-free summary.
- The Cloudbeds bundle is not loaded on `/booking-preview`. The WhatsApp button sits above the sticky bars.

## Go-live checklist

1. **Beam onboarding**
   - Confirm that villa / hotel stays are eligible.
   - Confirm the legal entity (KaSem Co., Ltd. vs Pakwan Samui LP), payout account, per-transaction maximum (stays can exceed 100k THB), and whether overseas cards are enabled.
2. **Playground run**
   - Set the playground env vars and `BOOKING_TOKEN_SECRET`.
   - Create a Lighthouse webhook to `https://<host>/api/beam/webhook` (events: `payment_link.paid`, `charge.succeeded`, `charge.failed`, `refund.*`) and set `BEAM_WEBHOOK_HMAC_KEY`.
   - Pay with 4111 1111 1111 1111.
   - Confirm the redirect, the status `paid`, and that the webhook signature verifies.
3. **Cloudbeds write key**
   - Create a NEW credential with `write:reservation` and `write:payment` (scopes cannot be added to the current key).
   - Create the custom payment method `beam` (`postCustomPaymentMethod`).
4. **Fulfilment (not built in the preview)**
   - Hold first: `postReservation` (sendEmailConfirmation=false, thirdPartyIdentifier=ref) before redirecting to Beam.
   - On a verified `payment_link.paid` webhook: `postPayment` (type=beam, description with the Beam charge id), then `putReservation status=confirmed`.
   - Cancel unpaid holds after 30 minutes with a cron sweep.
   - This needs a persistent store (KV or the droplet API) for idempotency, keyed on event + resource id.
   - Checkout will then need to accept guest details for `postReservation`. Today they stay in the browser.
5. **Rate parity**
   - Map the Breakfast plan to the Cloudbeds package (491264) and the `DIRECT` code to the Cloudbeds derived rate.
   - Confirm whether Cloudbeds rates include VAT and service charge (`getTaxesAndFees`).
6. **Analytics**
   - Add `beamcheckout.com` and `pay.beamcheckout.com` to GA4's unwanted referrals.
   - Check for double counting while `/booking` (Cloudbeds) and this engine run side by side.
7. **Legal and copy**
   - Update `/privacy` (it currently says Cloudbeds handles card details).
   - Decide whether to keep the visible card fee.
   - Show the cancellation policy and terms link.
8. **Switch on live mode**
   - Set the live keys, `BEAM_API_BASE=https://api.beamcheckout.com` and `BOOKING_ALLOW_LIVE_PAYMENTS=true`, on the Production environment only.
   - Make one small real charge and refund it.

## Open questions

**For Beam:**

- Are hotel / villa stays eligible, and can a Hong Kong entity be onboarded?
- Is there a maximum amount per link?
- Does `redirectUrl` receive extra query parameters?
- Is there a webhook event id, and what are the retry schedule and source IPs?
- What is the refund window via the API?
- Is the hosted page language English, and can it carry a logo or branding?
- Are Apple Pay and Google Pay supported?
- What is the settlement timing (T+1 PromptPay vs T+3 cards)?
- Is `charge.referenceId` always copied from the link's `order.referenceId`? The status fallback relies on it.

**For Cloudbeds:**

- Is `roomRate` per night or per stay? The code sums `roomRateDetailed` for now.
- Which `postReservation` fields are actually required (guestZip)?
- Which `paymentMethod` value should be sent for Beam-paid bookings?
- How does `postReservation` behave at zero availability?
- Do `not_confirmed` reservations block OTA inventory?
- Does getAvailableRoomTypes already enforce min-stay and closed-to-arrival restrictions?
- What is the room type id for tuxedo-3br?
- Do the combination room types share inventory inside Cloudbeds?
- What does the existing key's scope list contain?
- Is there a safe test property?

## Commands

```
npx tsc --noEmit
npm run lint
node --test src/lib/booking          # or: node --test "src/lib/booking/*.test.ts"
npm run build
```
