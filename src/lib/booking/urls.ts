// Absolute URLs for redirects. The origin comes from a fixed allow-list of
// hosts - never from an arbitrary Host header - so a forged header cannot
// turn our payment redirect/return URLs into an open redirect.

import type { Env } from "./config.ts";
import { isBookingRef } from "./ref.ts";
import type { ThemeName } from "./types.ts";

export const PREVIEW_PATH = "/booking-preview";
export const RETURN_PATH = "/booking-preview/return";
export const DEMO_PAY_PATH = "/booking-preview/beam-demo";

export const CANONICAL_ORIGIN = "https://magicsamui.com";
const PRODUCTION_HOSTS = new Set(["magicsamui.com", "www.magicsamui.com"]);
const LOCAL_HOSTS = new Set(["localhost:3000", "127.0.0.1:3000"]);

function normalizeHost(host: string | null | undefined): string {
  return (host ?? "").trim().toLowerCase().replace(/\.$/, "");
}

/** True when `host` (host[:port]) is one of ours. */
export function isAllowedHost(host: string, env: Env): boolean {
  const h = normalizeHost(host);
  if (h === "") return false;
  if (PRODUCTION_HOSTS.has(h)) return true;
  // Local development only - never on a Vercel deployment.
  if (LOCAL_HOSTS.has(h)) return !env.VERCEL_ENV;
  if (!/^[a-z0-9-]+\.vercel\.app$/.test(h)) return false;
  // Only this deployment's own URLs (set by Vercel at runtime). A bare
  // "<project>-*" prefix is NOT enough: any Vercel account can name a project
  // "magicsamui-website-pay" and own that subdomain.
  const exact = [env.VERCEL_URL, env.VERCEL_BRANCH_URL, env.VERCEL_PROJECT_PRODUCTION_URL].map(normalizeHost).filter(Boolean);
  if (exact.includes(h)) return true;
  // Optional: other preview URLs of our team. Vercel ends them with
  // "-<team-slug>.vercel.app", a suffix only our team's projects get.
  const team = normalizeHost(env.BOOKING_VERCEL_TEAM_SLUG);
  return /^[a-z0-9-]+$/.test(team) && h.endsWith(`-${team}.vercel.app`);
}

/** Origin (scheme + host) to build absolute URLs with. Falls back to the canonical site. */
export function resolveOrigin(host: string | null | undefined, env: Env): string {
  const h = normalizeHost(host);
  if (!isAllowedHost(h, env)) return CANONICAL_ORIGIN;
  return LOCAL_HOSTS.has(h) ? `http://${h}` : `https://${h}`;
}

/** Adds ?theme=classic (the default "magic" theme needs no parameter). */
function withTheme(q: URLSearchParams, theme: ThemeName | undefined): URLSearchParams {
  if (theme === "classic") q.set("theme", "classic");
  return q;
}

export function returnUrl(origin: string, ref: string, token: string, theme?: ThemeName): string {
  const q = withTheme(new URLSearchParams({ ref, t: token }), theme);
  return `${origin}${RETURN_PATH}?${q.toString()}`;
}

/** Where Beam's Cancel button (and the demo page's Cancel) sends the guest. */
export function cancelUrl(origin: string, ref: string, token: string, theme?: ThemeName): string {
  const q = withTheme(new URLSearchParams({ resume: "payment", ref, t: token }), theme);
  return `${origin}${PREVIEW_PATH}?${q.toString()}`;
}

/**
 * Stripe success_url: the own booking page's /return with the booking token
 * and Stripe's literal {CHECKOUT_SESSION_ID} placeholder (Stripe substitutes
 * it; it must NOT be percent-encoded, so it is appended by hand).
 */
export function stripeReturnUrl(origin: string, basePath: string, ref: string, token: string, theme?: ThemeName): string {
  const q = withTheme(new URLSearchParams({ ref, t: token }), theme);
  return `${origin}${basePath}/return?${q.toString()}&session_id={CHECKOUT_SESSION_ID}`;
}

/**
 * Stripe cancel_url (the "back" link on Checkout): back to the payment step.
 * The booking page must POST /api/booking/abandon with `t` (and the link
 * token) so the session is expired and the hold released at once.
 */
export function stripeCancelUrl(origin: string, basePath: string, ref: string, token: string, theme?: ThemeName): string {
  const q = withTheme(new URLSearchParams({ resume: "payment", reason: "cancelled", ref, t: token }), theme);
  return `${origin}${basePath}?${q.toString()}`;
}

/** Local stripe-mock checkout page (MOCK only). */
export const STRIPE_MOCK_PATH = "/booking-preview/stripe-mock";

export function demoPayUrl(origin: string, token: string, theme?: ThemeName): string {
  const q = withTheme(new URLSearchParams({ t: token }), theme);
  return `${origin}${DEMO_PAY_PATH}?${q.toString()}`;
}

/** Return URL after a successful simulated payment (adds the signed proof). */
export function demoReturnUrl(origin: string, ref: string, token: string, proof: string, theme?: ThemeName): string {
  const q = withTheme(new URLSearchParams({ ref, t: token, p: proof }), theme);
  return `${origin}${RETURN_PATH}?${q.toString()}`;
}

/**
 * Query parameters a booking page may keep in the address bar after its
 * one-shot cleanup: the theme, the ?staff device flag, and ad-click / cross-
 * domain ids (none of them personal data) that Google Ads (gclid, gbraid,
 * wbraid, gad_source, gad_campaignid, dclid), the GA linker (_gl), Microsoft
 * Ads (msclkid) and Meta (fbclid) use for attribution.
 */
const KEEP_PARAMS = new Set(["theme", "staff", "gclid", "gbraid", "wbraid", "gad_source", "gad_campaignid", "dclid", "_gl", "msclkid", "fbclid"]);

/**
 * The address-bar query to keep once a booking page has read its parameters:
 * an ALLOW-list (theme, the site's ?staff device flag, ad-click ids and utm_*),
 * so tokens, refs and anything a payment provider appends never reach the
 * analytics tags' page_location. Returns "" or "?a=b...".
 */
export function allowListedSearch(search: string): string {
  const out = new URLSearchParams();
  for (const [k, v] of new URLSearchParams(search)) {
    if (KEEP_PARAMS.has(k) || k.startsWith("utm_")) out.append(k, v);
  }
  const q = out.toString();
  return q ? `?${q}` : "";
}

/** "unverified": the return page couldn't confirm the payment either way. */
export type ResumeReason = "cancelled" | "failed" | "expired" | "unverified";

export function parseResumeReason(v: unknown): ResumeReason | null {
  return v === "cancelled" || v === "failed" || v === "expired" || v === "unverified" ? v : null;
}

/**
 * Same-origin path back to the payment step with the cart intact, used by the
 * return page's "Try again" links. The reason picks the notice copy. The
 * attempt's booking ref (when known) makes each recovery URL unique per
 * attempt: the booking page ignores a landing URL it has already applied
 * (Back/Forward replays), so two attempts must never share one URL.
 */
export function resumePaymentPath(reason: ResumeReason, theme?: ThemeName, ref?: string | null, basePath: string = PREVIEW_PATH): string {
  const q = new URLSearchParams({ resume: "payment", reason });
  if (isBookingRef(ref)) q.set("ref", ref);
  return `${safeBookingBasePath(basePath)}?${withTheme(q, theme).toString()}`;
}

/** The two own-booking-page paths; anything else falls back to the preview (never an open redirect). */
export function safeBookingBasePath(basePath: string | null | undefined): "/booking" | "/booking-preview" {
  return basePath === "/booking" ? "/booking" : PREVIEW_PATH;
}

/**
 * Same-origin return page for a booking attempt (used when the booking page
 * finds that an attempt it was about to abandon was already paid or is still
 * processing). Only the signed token and the ref - never personal data.
 */
export function returnPagePath(basePath: string, ref: string, token: string, theme?: ThemeName): string {
  const q = withTheme(new URLSearchParams({ ref, t: token }), theme);
  return `${safeBookingBasePath(basePath)}/return?${q.toString()}`;
}
