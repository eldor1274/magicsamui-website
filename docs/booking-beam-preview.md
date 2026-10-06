# Own booking engine with Beam payments: preview

This is a preview of a direct booking page that looks and flows like the Cloudbeds immersive engine, but takes payment through Beam (beamcheckout.com) instead of Cloudbeds.

It runs in **demo mode** by default. In demo mode:

- No card is charged.
- No reservation is created.
- No booking or ecommerce event (and no preview click event) reaches GA4 or Google Ads. The site-wide tags in `layout.tsx` still load on `/booking-preview*`, so GA4's automatic page_view, the Google Ads remarketing hit and GA4 enhanced-measurement events (form_start/form_submit, outbound clicks) do fire there (`layout.tsx` and `GaScript` are out of scope for the preview) - see the Analytics section.

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

### Repository notes

- `tsconfig.json` has `allowImportingTsExtensions: true` so `src/lib/booking` can use `.ts` import specifiers that Node 24 runs directly under `node --test`. It is harmless with `noEmit` (and Next/Turbopack resolve these specifiers).
- `src/lib/booking/index.js` is the test entry. It is ESM with top-level await in a package without `"type": "module"`, so it relies on Node 22.12+/24 module-syntax detection. It cannot be renamed to `index.mjs` because `node --test <dir>` resolves a directory through `index.js`.
- The Cloudbeds provider reads from API **v1.3** (identical read endpoints to v1.2, which `/api/rates` still uses).

### Why stateless tokens

The project has no database. The facts needed after the payment redirect travel in an HMAC-SHA256-signed token (`BOOKING_TOKEN_SECRET`): ref, dates, items, amounts, link expiry and payment mode.

Tokens never contain a name, email or phone, because they appear in URLs.

The Beam payment-link id is only known after the redirect URLs have been built. The checkout response therefore also returns a `linkToken` that carries the id. The browser stores it in sessionStorage, and the return page sends it to `/api/booking/status` as `l`.

- With the link id, status asks `GET /api/v1/payment-links/{id}` (authoritative). Before an `EXPIRED` / `DISABLED` answer is shown (it offers "Try again", i.e. a second payment), it also checks `GET /api/v1/charges?source_in=PAYMENT_LINK&sourceId={id}` and answers `paid` if a charge on that link succeeded (a PromptPay QR or slow 3-D Secure step finishing at the 30-minute deadline).
- Without it (the server render of the return page never sees sessionStorage; a new tab), status falls back to `GET /api/v1/charges?referenceId=…&source_in=PAYMENT_LINK`. Whether Beam copies `referenceId` onto charges is undocumented, so this fallback answers `paid` or `pending`, **never `expired`**. The return page then re-checks with the link token from this tab before showing any unpaid view, and after its polling budget it says "please don't pay again - message us" (with a "Back to your booking" link carrying the unverified warning), never "Try again".
- Recovery links back to the booking page carry the attempt's `ref`, so each attempt's URL is unique (the page ignores a landing URL it has already applied); the "If you've already paid, message us" warning is shown whenever `reason=unverified` is asked for.

## Modes

`config.ts` derives everything from environment variables. Secrets are only read in server code and never use `NEXT_PUBLIC_`.

| paymentMode | When | What happens |
|---|---|---|
| `demo` (default) | Anything that isn't the two rows below | Simulated Beam page. The built-in demo token secret is allowed **only off Vercel** (local `npm run dev`). |
| `beam-playground` | `BEAM_MERCHANT_ID` + `BEAM_API_KEY` set **and** `BEAM_API_BASE=https://playground.api.beamcheckout.com` | Real Beam sandbox payment links. Test cards only. |
| `beam-live` | `BEAM_API_BASE=https://api.beamcheckout.com` **and** `BOOKING_ALLOW_LIVE_PAYMENTS=true` **and** `VERCEL_ENV=production` (and keys) **and** dataSource `cloudbeds` **and** the code constant `LIVE_FULFILMENT_READY` (currently `false`) | Real charges. **Unreachable in this preview** - see below. |

How bad settings are handled:

- If `BEAM_API_BASE` points at the live API but any of the live conditions is missing, the configuration is **refused**. Checkout and status answer `503 live_payments_locked`, and the page banner shows the lock. Live mode is never used silently.
- An unrecognised `BEAM_API_BASE` is refused in the same way.
- `BOOKING_TOKEN_SECRET` of at least 32 random characters is needed in both `beam-*` modes **and on every Vercel deployment, demo included** (`VERCEL_ENV` set). The built-in demo secret is in the public repository, so on a deployment anyone could mint tokens with it and make magicsamui.com show a fake "Payment successful" page. Without a strong secret, checkout and demo-pay answer 503 (`token_secret_missing`), the simulated Beam page 404s and the banner shows "Payments locked"; browsing still works. The public built-in secret and trivially repetitive strings are refused.
- Tokens are also validated by shape after the signature check (`isBookingSummary` in `token.ts`): a well-formed `MSV-YYYYMMDD-XXXX` ref, real dates and night count, 1-6 bookable catalogue rooms with valid plans, party sizes and add-ons, sane integer amounts and a known theme. Anything else is `malformed`, so a token can never put arbitrary text on our pages.
- **Live is hard-stopped in code.** `config.ts` exports `LIVE_FULFILMENT_READY = false`. While it is false, `beam-live` is refused (`live_payments_locked`) even when every environment condition holds, because the preview creates no Cloudbeds reservation, its webhook only logs, and guest details never leave the browser: a real payment could not be fulfilled. Flip it only in the change that adds hold-first `postReservation` and guest capture.
- **Live needs live data.** `beam-live` is also refused unless the data source is `cloudbeds` (key set, `BOOKING_DATA_SOURCE` not `demo`).
- **No demo stand-in once money could move.** In any `beam-*` mode a failed Cloudbeds call is never replaced by simulated data: `/api/booking/availability` answers 503 and checkout answers `503 payment_unavailable` ("We could not confirm live availability. Nothing has been charged.") without calling Beam. `beam-playground` may still run on deliberately configured demo data (test money only); `beam-live` may not.
- **Promos are demo-only.** `DIRECT` (`BOOKING_DEMO_PROMO_PCT`) works only in `demo` mode, and only the demo hints at it in the "unknown code" message. In any Beam mode promos are off until `DIRECT` maps to a Cloudbeds derived rate. `PublicBookingConfig.promoEnabled` tells the page, which then drops the "Use code DIRECT" perk and code-picker hint.

| dataSource | When |
|---|---|
| `cloudbeds` | `CLOUDBEDS_API_KEY` is set and `BOOKING_DATA_SOURCE` is not `demo`. Uses the existing read-only key. |
| `demo` | Otherwise. A deterministic calendar with about 35% of unit-nights booked, busier at weekends and in high season. |
| `demo-fallback` | A Cloudbeds call failed **in demo payment mode**. The response uses demo data and the banner says so. Never used in beam-* modes (503 instead). |

### Environment variables

| Name | Default | Notes |
|---|---|---|
| `BEAM_API_BASE` | unset | Playground or live base URL. |
| `BEAM_MERCHANT_ID`, `BEAM_API_KEY` | unset | From Lighthouse > Developers. Playground and live keys differ. |
| `BEAM_WEBHOOK_HMAC_KEY` | unset | Base64 HMAC key of the Lighthouse webhook. When unset, the webhook answers 503. |
| `BOOKING_TOKEN_SECRET` | demo built-in (local only) | 32+ random characters (e.g. `openssl rand -base64 48`). **Required on every Vercel environment** (Production, Preview, Development) and in beam-* modes. Set it before deploying this branch, or the deployed preview shows "Payments locked". |
| `BOOKING_ALLOW_LIVE_PAYMENTS` | unset | Must be exactly `true` for live mode. |
| `BOOKING_DATA_SOURCE` | unset | Set it to `demo` to force simulated availability even when a Cloudbeds key exists. |
| `CLOUDBEDS_API_KEY` | existing | Read-only use. |
| `CLOUDBEDS_PROPERTY_ID` | unset | Optional. Sends `propertyIDs` to Cloudbeds. |
| `BOOKING_CARD_FEE_PCT` | unset (Beam 3, demo 3, Stripe 5) | Payment processing fee (card or PromptPay), shown visibly. Clamped 0–10. **Leave it unset** to get each provider's default (owner decision: 3% on Beam, 5% on Stripe). One value overrides the fee of **whichever provider is active**, so an override left in Vercel would also apply after a switch to another provider. |
| `BOOKING_DEPOSIT_PCT` | 100 | Share of the total due now. Clamped 1–100. |
| `BOOKING_DEMO_PROMO_PCT` | 10 | `DIRECT` discount on the room subtotal. Clamped 0–50. |
| `BOOKING_VERCEL_TEAM_SLUG` | unset | Optional. Also allow other preview hosts ending in `-<team-slug>.vercel.app` (a suffix only our Vercel team gets). Without it only this deployment's own `VERCEL_URL` / `VERCEL_BRANCH_URL` / `VERCEL_PROJECT_PRODUCTION_URL` are allowed. |

## Money and pricing

- All arithmetic is in **integer satang**. Each derived amount is rounded half-up once.
- Amounts are displayed like Cloudbeds (`18,750.00`), with a `THB` prefix on totals.
- Demo nightly rate: the `rooms.ts` priceThb, ×1.3 in high season (20 Dec–10 Jan and 1 Jul–31 Aug), ×1.1 on Friday and Saturday nights, rounded to whole baht.
- Rate plans:
  - **Standard Rate**
  - **Breakfast**: +1,000 THB per guest per night.
- Add-on "Breakfast per person": 1,000 THB per guest per eligible night, on Wednesday, Thursday and Friday nights only. It can only be added to the Standard Rate.
- Promo `DIRECT` (any case) gives `BOOKING_DEMO_PROMO_PCT`% off the room subtotal. Unknown codes get a friendly error.
- Payment processing fee: the provider's default (3% on Beam and in demo, 5% on Stripe) or `BOOKING_CARD_FEE_PCT`% when set, of (rooms + add-ons − promo), labelled "Payment processing fee (3%)" on Beam (the configured percentage) everywhere, and shown under each room card's price. It is shown **visibly**; Cloudbeds currently hides its 5% fee. It is baked into the Beam link amount before the guest picks a method, so it applies to PromptPay too - hence not "card" fee (see the go-live checklist).
- Room cards show the promo-discounted stay price (struck-through original + "incl. DIRECT −10%"), rounded exactly like the quote's promo line, so card, summary and server agree.
- Deposit: `BOOKING_DEPOSIT_PCT`% of the total, shown as "Due now". The Beam `order.netAmount` is this amount.
- Occupancy (Cloudbeds data): search asks `getAvailableRoomTypes` with `adults=1` so every room type is listed, and reads each room's `adultsIncluded` / `adultsExtraCharge` table. A line's room total is the sum of `roomRateDetailed` plus `adultsExtraCharge[adults]` (treated as the extra for the whole stay). The checkout re-quote prices from **the same `adults=1` answer** (fresh, `cache: no-store`), so search and checkout can never disagree structurally. It also asks Cloudbeds once per distinct party size in the cart (`adults=N`), but only as an **availability gate**: a room Cloudbeds doesn't offer at that occupancy is refused (`unavailable`). When the `adults=N` rate differs from the `adults=1` rate, checkout logs `cloudbeds_occupancy_rate_differs` (slug, adults, both totals, the table's extra, and whether the rate already includes it) so the open question below gets answered from real traffic. Search answers are cached for 60 s per server instance so preview traffic cannot exhaust the key's shared 10 req/s limit (shared with `/api/rates` and the owner's droplet cron). On top of that every preview call to Cloudbeds draws on a per-instance budget (`CLOUDBEDS_PREVIEW_BUDGET` in `cloudbedsProvider.ts`: about 3 calls/s, burst 8). When it is used up, search answers with demo data (`demo-fallback` banner) in demo mode and 503 in Beam modes; checkout waits up to 3 s for budget, then refuses with 503 (nothing charged). `?fresh=1` (used right after a checkout conflict) bypasses the cache only 3 times per IP per 10 minutes; after that the cached answer is served. The checkout's party-size checks run one after another, never in parallel.
- Occupancy limits: Cloudbeds' `maxGuests` (from the `adults=1` rows) caps each offer (`RoomOffer.maxAdults` = min(site figure, Cloudbeds)), so the occupancy picker never offers more guests than Cloudbeds accepts and checkout refuses a larger party up front. A room refused only for its party size comes back as `unavailable` with `occupancySlugs` and the copy "can't be booked online for N guests - try fewer guests or message us"; the browser then caps that room at N-1 guests for these dates instead of marking it sold.
- Rate row choice (Cloudbeds): the base row (no plan name, not derived) always wins; otherwise a non-derived plan row; a derived row (non-refundable, promo) only when nothing else exists. Within a tier the cheaper row wins, so row order never changes the price.
- At checkout the server **always re-quotes** from (slug, ratePlanId, dates, adults, add-ons, promo). The browser sends `expectedTotalSatang` and `expectedDueNowSatang` (what the Pay button said) only so the server can answer `price_changed` with the new quote when either differs (e.g. a deposit % changed by a redeploy mid-session). Any other price field in the request is ignored.
- After `price_changed` the server's quote becomes the one shown and paid (`state.serverQuote`, valid only for that exact cart, dates and promo), so a pricing difference between browser and server can never trap the guest in a loop. After `unavailable` the refused rooms are removed from the cart and not offered again for those dates; the follow-up search bypasses the cache.
- POST bodies: `application/json` only (415 otherwise, so cross-site text/plain form posts are refused), read through a capped stream (413 over 16 KB / 4 KB; the webhook 64 KB) - never buffered whole first.
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

No personal data is ever included. The preview has its own copy of the "Having trouble paying?" strip (`BookingHelp.tsx`) whose `booking_help_*` events go through the same gate; the shared `/booking` strip is untouched.

Payloads match Cloudbeds': every event carries `property_id` ("235064"), `item_name` is the Cloudbeds room type name (`CLOUDBEDS_ROOM_NAMES` in `src/data/cloudbeds.ts`, captured from the live engine) so one `item_id` never appears under two names, and `begin_checkout` / `purchase` carry `subtotal` (total before the card fee). In live mode the per-tab purchase guard is set from gtag's `event_callback`, i.e. only once gtag.js has really sent the event (it loads late); within one page load an in-memory guard stops duplicates.

The site-wide WhatsApp button does not send `whatsapp_fab_click` on `/booking-preview*`. What still fires there comes from `layout.tsx` (out of scope): GA4's automatic page_view, the Ads remarketing hit and enhanced-measurement events. See go-live step 6 for filtering it.

Personal data shown or typed on screen (the whole guest details form, lead guest on the payment review, the guest name/email on the return page, the simulated card form) carries `data-clarity-mask` so Microsoft Clarity recordings never capture it, whatever the masking mode in the Clarity dashboard.

## Safety checklist (preview)

- Card data never touches our servers.
  - Beam hosts the real form.
  - The demo page checks test card numbers in the browser only.
  - `/api/booking/demo-pay` rejects any field except `t` and `outcome`.
- Redirect and return URLs are built from an allow-list of hosts: magicsamui.com, www, this deployment's own `*.vercel.app` URLs (plus, optionally, hosts ending in `-<BOOKING_VERCEL_TEAM_SLUG>.vercel.app`), and localhost:3000 off Vercel only. A project-name prefix alone is not trusted (anyone can create `magicsamui-website-x.vercel.app`). The Host header is never trusted as-is.
- Bearer tokens out of analytics: the return page and the simulated Beam page move `t` / `p` / `ref` from the address bar into this tab's sessionStorage on mount (Reload still works) and clean the address bar with `history.replaceState`, before the site-wide gtag.js (GA4 + Google Ads) and Clarity load and record the URL. The cleanup (return page and `/booking-preview`) is an **allow-list** (`allowListedSearch` in `urls.ts`: `theme`, the site's `staff` flag, ad-click ids, `utm_*`), so anything Beam might append to `redirectUrl` / `cancelUrl` is dropped too.
- The simulated Beam page renders without the site header, footer and WhatsApp button, like a real hosted checkout.
- The browser follows only same-origin redirects or redirects to `pay.beamcheckout.com` / `playground-pay.beamcheckout.com`.
- Webhook verification:
  - It uses HMAC-SHA256 over the exact raw body, with the base64-decoded key.
  - It is tested against Beam's published test vector.
  - The preview only logs a PII-free summary.
- The Cloudbeds bundle is not loaded on `/booking-preview`. The bottom bars publish their heights (`--bk-cart-bar-h`, `--bk-fab-lift`), so the help strip stacks above the cart bar and the WhatsApp button lifts only when a bar is actually showing.
- The chosen theme survives the Beam round trip (it travels in the signed token and as `&theme=classic` on the cancel/return URLs, including the "link not valid" screen); theme-switch links carry only `?theme`, and the `?checkin/?checkout/?adults/?promo` prefill is applied once and then removed from the address bar. Because the App Router can replay the original URL from its cache on Back/Forward, a hash of the one-shot params (`landingKey`) is saved with the booking and a replayed landing is ignored.
- Browser history: each forward step pushes an entry; the in-app back arrow and Edit links return to the existing entry (or rewrite the current one), so the browser / Android Back button keeps going back. A back/forward-cache restore re-reads the saved booking, so a cart cleared after payment can't be paid twice. When the App Router rewrites an entry's state during a Back/Forward that needs a server round trip (entries from before a reload whose URL had one-shot params), `bkStep`/`bkIndex` are stamped back onto the entry after that render; an entry that still arrives without them is placed with the Navigation API's entry index where the browser has it, otherwise the current step is kept and the entry re-stamped.

## Go-live checklist

1. **Beam onboarding**
   - Confirm that villa / hotel stays are eligible.
   - Confirm the legal entity (Pakwan Samui LP, the Stripe account holder named on `/legal` since 2026-10-06), payout account, per-transaction maximum (stays can exceed 100k THB), and whether overseas cards are enabled.
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
   - On a verified `payment_link.paid` webhook: `postPayment` (type=beam, description with the Beam charge id), then `putReservation status=confirmed`. `postPayment` / `postVoidPayment` exist on **v1.3 only** (removed from v1.2 on 2025-12-01); rely on `success` + `paymentID`, not `transactionID`.
   - Consider `postRoomBlock` (courtesy_hold) as the inventory hold instead of a not-confirmed reservation.
   - Make the Beam idempotency key stable per booking (today it is salted per checkout attempt): that needs a store, because Beam answers 412 when a key is reused with a different body and every attempt has a new `expiresAt`. Disable the previous link (`PATCH /payment-links/{id}/disable`) when the guest returns via Cancel.
   - Then set `LIVE_FULFILMENT_READY = true` in `config.ts` in that same change.
   - Cancel unpaid holds after 30 minutes with a cron sweep.
   - This needs a persistent store (KV or the droplet API) for idempotency, keyed on event + resource id.
   - Checkout will then need to accept guest details for `postReservation`. Today they stay in the browser.
5. **Rate parity**
   - Map the Breakfast plan to the Cloudbeds package (491264) and the `DIRECT` code to the Cloudbeds derived rate.
   - Confirm whether Cloudbeds rates include VAT and service charge (`getTaxesAndFees`).
6. **Analytics**
   - Add `beamcheckout.com` and `pay.beamcheckout.com` to GA4's unwanted referrals.
   - GA4 Admin > Data streams > (web stream) > Redact data > URL query parameters: add `t`, `p`, `l` (belt and braces - the pages already strip them before gtag.js loads).
   - Exclude `/booking-preview/*` from every URL-based Google Ads conversion.
   - While the preview is up, keep its traffic out of reports: a GA4 data filter (or report filter) on `/booking-preview`, or test only from devices marked with `?staff=1` (no GA4/Ads/Clarity there).
   - Send `purchase` server-side too, through the GA4 Measurement Protocol from the verified Beam webhook (`transaction_id` = booking ref), so a guest who closes the confirmation page before gtag.js loads is still counted. GA4 and the Ads import de-duplicate on `transaction_id`.
   - Check for double counting while `/booking` (Cloudbeds) and this engine run side by side.
7. **Legal and copy**
   - Update `/privacy` (it currently says Cloudbeds handles card details).
   - **Owner sign-off on the fee label:** the brief asked for "Card processing fee (5%)"; the preview says "Payment processing fee (3%)" on Beam (the configured percentage; summary, payment review, return page) because the fee is baked into the one Beam link and so also applies to PromptPay. Rename it only together with a card-only fee (below).
   - Decide whether to keep the visible processing fee, and **confirm surcharging is allowed** under the Beam merchant agreement and the card scheme rules for Thailand (Visa/Mastercard limit or forbid card surcharges). The fee is currently charged on PromptPay too because one Beam link offers both methods; the alternative is a Card / PromptPay choice on the payment step with a method-specific link and the fee on cards only.
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
- Is `charge.referenceId` always copied from the link's `order.referenceId`? The no-link-id status fallback uses it (and so never answers "expired" on its own).

**For Cloudbeds:**

- Is `roomRate` per night or per stay? The code sums `roomRateDetailed` for now.
- **Occupancy pricing (go-live blocker):** is `adultsExtraCharge[N]` the extra for the whole stay or per night, and does an `adults=1` query return the full table? Does `roomRateDetailed` at `adults=N` already include the extra-adult charge? Search and checkout now both price from the `adults=1` answer plus the table, so they always agree (no `price_changed` loop); the remaining question is only whether that price equals what Cloudbeds itself charges at `adults=N`. The `cloudbeds_occupancy_rate_differs` log line answers it from real checkouts (`rateIncludesExtra: true` means the two match); also check with one read-only call at adults=1 and adults=maxGuests for the 3-bedroom units.
- Which `postReservation` fields are actually required (guestZip)?
- Which `paymentMethod` value should be sent for Beam-paid bookings?
- How does `postReservation` behave at zero availability?
- Do `not_confirmed` reservations block OTA inventory?
- Does getAvailableRoomTypes already enforce min-stay and closed-to-arrival restrictions?
- What is the room type id for tuxedo-3br? **Answered (WI-0, 2026-10-06):** none was returned by `getRoomTypes`, so it stays enquiry-only; see `docs/booking-engine.md` section 3, row 4.
- Do the combination room types share inventory inside Cloudbeds? Consistent with it on 2026-10-06, not yet proven: see `docs/booking-engine.md` section 3, row 3 (and Stage B tests 10 and 11).
- What does the existing key's scope list contain?
- Is there a safe test property?

## Intentional differences from the Cloudbeds engine

- No "Accommodation types" **Filters** control: with 11 room types (12 cards) the list is short enough without it.
- The processing fee is shown as its own line with a visible explanation (Cloudbeds hides it in a suppressed tooltip).
- The `classic` theme uses Poppins (as Cloudbeds) through `next/font`, not preloaded, so the default `magic` theme never downloads it.

## Commands

```
npx tsc --noEmit
npm run lint
node --test src/lib/booking          # or: node --test "src/lib/booking/*.test.ts"
npm run build
```
