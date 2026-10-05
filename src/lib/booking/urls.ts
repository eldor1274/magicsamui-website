// Absolute URLs for redirects. The origin comes from a fixed allow-list of
// hosts - never from an arbitrary Host header - so a forged header cannot
// turn our payment redirect/return URLs into an open redirect.

import type { Env } from "./config.ts";

export const PREVIEW_PATH = "/booking-preview";
export const RETURN_PATH = "/booking-preview/return";
export const DEMO_PAY_PATH = "/booking-preview/beam-demo";

export const CANONICAL_ORIGIN = "https://magicsamui.com";
const PRODUCTION_HOSTS = new Set(["magicsamui.com", "www.magicsamui.com"]);
const LOCAL_HOSTS = new Set(["localhost:3000", "127.0.0.1:3000"]);
const DEFAULT_VERCEL_PROJECT = "magicsamui-website";

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
  const exact = [env.VERCEL_URL, env.VERCEL_BRANCH_URL, env.VERCEL_PROJECT_PRODUCTION_URL].map(normalizeHost);
  if (exact.includes(h)) return true;
  const project = (env.BOOKING_VERCEL_PROJECT ?? DEFAULT_VERCEL_PROJECT).toLowerCase();
  return h === `${project}.vercel.app` || h.startsWith(`${project}-`);
}

/** Origin (scheme + host) to build absolute URLs with. Falls back to the canonical site. */
export function resolveOrigin(host: string | null | undefined, env: Env): string {
  const h = normalizeHost(host);
  if (!isAllowedHost(h, env)) return CANONICAL_ORIGIN;
  return LOCAL_HOSTS.has(h) ? `http://${h}` : `https://${h}`;
}

export function returnUrl(origin: string, ref: string, token: string): string {
  const q = new URLSearchParams({ ref, t: token });
  return `${origin}${RETURN_PATH}?${q.toString()}`;
}

/** Where Beam's Cancel button (and the demo page's Cancel) sends the guest. */
export function cancelUrl(origin: string, ref: string, token: string): string {
  const q = new URLSearchParams({ resume: "payment", ref, t: token });
  return `${origin}${PREVIEW_PATH}?${q.toString()}`;
}

export function demoPayUrl(origin: string, token: string): string {
  const q = new URLSearchParams({ t: token });
  return `${origin}${DEMO_PAY_PATH}?${q.toString()}`;
}

/** Return URL after a successful simulated payment (adds the signed proof). */
export function demoReturnUrl(origin: string, ref: string, token: string, proof: string): string {
  const q = new URLSearchParams({ ref, t: token, p: proof });
  return `${origin}${RETURN_PATH}?${q.toString()}`;
}
