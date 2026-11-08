# Security review - magicsamui.com + Beam booking page (8 Nov 2026)

Defensive self-review of systems Pakwan Samui LP / Magic Samui owns: this Next.js 16 site
(deployed on Vercel), its own booking engine (Beam live, Stripe fallback) and the support
endpoints the WhatsApp bot uses. Scope: guest personal data and payments. Everything below
was verified against the code and, where a server was involved, against a local dev server
with placeholder secrets (status codes only; no guest data or secret values were printed).

The same day a review of the separate Stripe booking engine (`F:\claude work file\booking-engine`)
found and fixed an unauthenticated `/admin` page and an ID-enumeration leak on `/api/bookings/[id]`.
Those fixes are in that repo, not here.

## Findings

| # | Area | Severity | Finding | Status |
|---|------|----------|---------|--------|
| 1 | `POST /api/points/admin` | **High** | One shared password guarded every guest's loyalty record (an empty search returns everyone with a balance: name, phone tail, stays, spend) and the ability to clear points. It was compared with plain `===`, had **no rate limit** (the only sensitive route without one) and no minimum length. | **Fixed.** Constant-time compare; `POINTS_ADMIN_PASSWORD` must be 16+ characters or the route answers 503 (fails closed); after 10 wrong passwords from one IP in 10 minutes every attempt from that IP gets 429 for the rest of the window (right password included); refusals are logged. Successful use is never counted. |
| 2 | `POST /api/points/lookup` | **Medium** | The comment promised "phone AND surname"; the code only required the phone, and `lookup()` returned the account when the surname was empty. Anyone with a guest's phone number got their name, points balance, stay count and expiry (balance is 5% of net spend, so roughly what they paid). | **Fixed.** Surname is required in the route (400 without it) and `lookup()` returns nothing on an empty surname. |
| 3 | `POST /api/scroll-diag` | **Medium** | The access key was a string literal present in both the route and the client component, i.e. shipped in the public JS bundle - so effectively an unauthenticated write path: up to 700 KB per request appended to `site-scroll-diag.jsonl` on the droplet, one email to the owner per report, `env`/`switches` stored unbounded, and the stored text is read later by an AI agent with root on the droplet (a prompt-injection vector). | **Fixed.** Server-only `SCROLL_DIAG_KEY` (16+ chars) - **off by default**: unset means 404 for everything. Constant-time compare. The recorder now takes the key from the owner's own URL (`/booking/classic?diag=<key>`), so nothing secret is in the bundle. `env` is reduced to short scalar fields (max 40), `switches` capped at 200. The notice email says the file is untrusted data. |
| 4 | `POST /api/contact` | Low | The sender's name (100 chars, line breaks allowed) went straight into the mail `Subject` header. | **Fixed.** CR/LF stripped from the subject. |
| 5 | Local dev: `magic-suites-promo` launcher (`F:\claude work file\.claude\launch.json`) | **High** (local network) | `python -m http.server` served the **whole** `F:\claude work file` folder and, by default, listened on every network interface. While running, anyone on the same Wi-Fi could fetch `Beam/attachments/*` (passport and ID-card scans from the Beam KYC pack) and `booking-engine/.env.local` (live Stripe keys). | **Fixed** (`--bind 127.0.0.1`, localhost only). **Recommended:** move the KYC scans out of this folder into encrypted storage, or delete the local copies - Beam onboarding was completed on 19 Oct 2026. |
| 6 | Checkout config | Low (design) | On production with `BOOKING_PAYMENT_PROVIDER` unset but a token secret present, checkout runs in **demo** mode (simulated payment page; no hold, no charge, no money impact). | Not changed. Noted as a production path to "fake" bookings; `BOOKING_PAYMENT_PROVIDER` is set on production today. |
| 7 | Rate limiters (contact, waitlist, scroll-diag, points, booking) | Low | All per-IP limits live in memory per serverless instance, so cold starts and parallel instances multiply them; the ad-hoc maps in contact/waitlist/points have no size cap (`createRateLimiter` clears at 5,000 entries). They also trust the first `x-forwarded-for` value, which is fine on Vercel. | Not changed. Acceptable for a small site; Upstash Redis is already a dependency if a shared limiter is ever wanted. |
| 8 | `contact`, `eldor-waitlist` | Low | Unguarded `request.json()` turns malformed JSON into a generic 500. | Not changed (cosmetic; no data exposure). |

## Verified as done right

- **Beam webhook**: `X-Beam-Signature` HMAC over the exact raw body, constant-time compare (`src/lib/booking/beam.ts:951`), body read capped at 64 KB, 503 before the body is touched when `BEAM_WEBHOOK_HMAC_KEY`/deps are missing.
- **Stripe webhook**: signature over the raw body, capped read, 503/404 when not configured.
- **Payment bypass routes**: `demo-pay`, `mock-stripe`, `test-access` answer 404 outside their modes; `stripe-mock` is refused when `VERCEL_ENV=production` (`config.ts:495`); test-mode Cloudbeds writes need the HMAC staff cookie.
- **No ID enumeration on bookings**: `status` and `abandon` require the HMAC-signed booking token, bound to the booking ref (a token for booking A cannot touch booking B).
- **Checkout pricing is server-side**: the client sends ids/dates/promo code; the server re-quotes from Cloudbeds and answers 409 on any mismatch; dates, nights and cart size are capped; demo prices never reach live payments; origin for redirects is allow-listed; bodies limited to 16 KB and JSON only.
- **Cron/bot routes** (`sweep`, `health-check`, `support/payment-lookup`): bearer secrets with minimum lengths, constant-time compare (`src/lib/bearerAuth.ts`), fail closed (503/404) when unset. Email-only payment lookups deliberately withhold details.
- **Secrets**: no `.env*` file was ever committed (`git log --all`); the only `NEXT_PUBLIC_*` values are GA, Vercel env and site verification; the secret-looking strings in `src/lib/booking` are labelled mock/test constants and test fixtures.
- **Headers**: `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy` on every route; HSTS comes from Vercel.
- **Error responses** never include stack traces, paths or env var names; upstream (Cloudbeds/Stripe/Beam) error text goes to server logs only.

## Verification

- `npx tsc --noEmit -p .` - clean.
- `node --test src/lib/booking` - **1073 pass, 0 fail**.
- `npx eslint` on the changed files - 2 errors in `src/components/ScrollDiag.tsx` (`react-hooks/set-state-in-effect`, `react-hooks/purity`) that are **pre-existing**: the same lines fail on the untouched committed version. Not touched here.
- Live checks on the local dev server (`preview_start "magicsamui-sec-dev"`, placeholder secrets):

| Request | Result |
|---------|--------|
| `points/admin` without password | 401 |
| `points/admin` with the configured password | 200 |
| `points/admin`, 10th wrong password from one IP | 429 (and the right password from that IP is also 429 until the window passes) |
| `points/lookup` with phone only | 400 |
| `points/lookup` with phone + surname | 200 `{found:false}` |
| `scroll-diag` with `SCROLL_DIAG_KEY` unset | 404 (off by default) |
| `scroll-diag` without key / with the old bundle literal | 401 / 401 |
| `scroll-diag` with the configured key | 502 locally (key accepted; no droplet relay here) |
| `/`, `/booking/classic`, `/points/admin` (login form) | 200 |

## Before deploying - owner checklist

1. **Check `POINTS_ADMIN_PASSWORD` in Vercel is at least 16 characters.** Shorter, and the points admin will answer 503 after this deploy until it is lengthened. Pick a long random one.
2. **`SCROLL_DIAG_KEY` is new and optional.** The scroll recorder is off until it is set. To record: set a 16+ character value in Vercel, open `/booking/classic?diag=<that value>` on the phone, send the report, then remove the variable again.
3. Move or delete the passport/ID scans in `F:\claude work file\Beam\attachments` (local disk; nothing on the site).
4. Nothing is committed: `git status` in `magicsamui-website` lists the changed files below. The launcher changes are in `F:\claude work file\.claude\` (not a git repo).

## Files changed in this repo

- `src/app/api/points/admin/route.ts` - constant-time compare, 16+ char minimum, per-IP failure lockout, logging
- `src/app/api/points/lookup/route.ts` - surname required
- `src/lib/points.ts` - `lookup()` returns null on an empty surname
- `src/app/api/scroll-diag/route.ts` - server-only key, off by default, constant-time, env/switches capped
- `src/components/ScrollDiag.tsx`, `src/components/ScrollDiagGate.tsx` - key from `?diag=<key>`, literal removed
- `src/app/api/contact/route.ts` - subject header sanitised
- `SECURITY-REVIEW-2026-11-08.md` - this file
