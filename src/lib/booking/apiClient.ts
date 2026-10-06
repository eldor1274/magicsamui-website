// Browser-side wrappers for the booking API. They never throw: failures come
// back as ApiError objects so components can render a message.

import { ALL_PAYMENT_REDIRECT_HOSTS } from "./payments/provider.ts";
import type {
  AbandonRequest,
  AbandonResponse,
  ApiError,
  AvailabilityResponse,
  CheckoutRequest,
  CheckoutResponse,
  DemoPayRequest,
  DemoPayResponse,
  StatusResponse,
  StaySearch,
} from "./types.ts";

const NETWORK_ERROR: ApiError = {
  ok: false,
  error: "network_error",
  message: "We couldn't reach the server. Please check your connection and try again.",
};

async function request<T>(input: string, init?: RequestInit): Promise<T | ApiError> {
  try {
    const res = await fetch(input, { ...init, cache: "no-store" });
    const json = (await res.json().catch(() => null)) as T | ApiError | null;
    if (json && typeof json === "object" && "ok" in json) return json;
    return { ok: false, error: "server_error", message: `Unexpected response (${res.status}). Please try again.` };
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    return NETWORK_ERROR;
  }
}

export function availabilityUrl(search: StaySearch, options: { fresh?: boolean } = {}): string {
  const q = new URLSearchParams({ checkin: search.checkIn, checkout: search.checkOut, adults: String(search.adults) });
  if (search.promo) q.set("promo", search.promo);
  if (options.fresh) q.set("fresh", "1");
  return `/api/booking/availability?${q.toString()}`;
}

/**
 * GET /api/booking/availability. Rejects only with AbortError when `signal`
 * aborts. `fresh` bypasses the server's short search cache (after a checkout conflict).
 */
export function fetchAvailability(
  search: StaySearch,
  signal?: AbortSignal,
  options: { fresh?: boolean } = {},
): Promise<AvailabilityResponse | ApiError> {
  return request<AvailabilityResponse>(availabilityUrl(search, options), { signal });
}

export function postCheckout(body: CheckoutRequest): Promise<CheckoutResponse> {
  return request<CheckoutResponse>("/api/booking/checkout", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as Promise<CheckoutResponse>;
}

export function fetchStatus(
  params: { t: string; p?: string | null; l?: string | null; s?: string | null },
  signal?: AbortSignal,
): Promise<StatusResponse | ApiError> {
  const q = new URLSearchParams({ t: params.t });
  if (params.p) q.set("p", params.p);
  if (params.l) q.set("l", params.l);
  // Stripe: the Checkout Session id from the return URL's session_id.
  if (params.s) q.set("s", params.s);
  return request<StatusResponse>(`/api/booking/status?${q.toString()}`, { signal });
}

/** Posts ONLY {t, outcome}. Never pass card fields here. */
export function postDemoPay(body: DemoPayRequest): Promise<DemoPayResponse> {
  return request<DemoPayResponse>("/api/booking/demo-pay", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ t: body.t, outcome: body.outcome }),
  }) as Promise<DemoPayResponse>;
}

const LINK_TOKEN_PREFIX = "msv_booking_link_";

/** Keep the Beam link token for the return page (same tab, survives the redirect). */
export function rememberLinkToken(ref: string, linkToken: string | null): void {
  if (!linkToken) return;
  try {
    sessionStorage.setItem(LINK_TOKEN_PREFIX + ref, linkToken);
  } catch {
    // storage blocked - status falls back to a lookup by reference
  }
}

export function recallLinkToken(ref: string): string | null {
  try {
    return sessionStorage.getItem(LINK_TOKEN_PREFIX + ref);
  } catch {
    return null;
  }
}

/**
 * POST /api/booking/abandon (Stripe): call when the guest is back from
 * Stripe's back link (?resume=payment&reason=cancelled&t=...) or presses
 * Cancel. Expires the session and releases the room hold; never cancels a
 * paid booking (state "paid" -> show the return page instead).
 */
export function postAbandon(body: AbandonRequest): Promise<AbandonResponse> {
  return request<AbandonResponse>("/api/booking/abandon", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ t: body.t, l: body.l ?? null, s: body.s ?? null }),
  }) as Promise<AbandonResponse>;
}

/**
 * Only follow a checkout redirect to our own origin or a payment provider's
 * hosted page (checkout.stripe.com, Beam's pages) over https.
 */
export function isAllowedPaymentRedirect(url: string, currentHref: string): boolean {
  try {
    const u = new URL(url, currentHref);
    if (u.origin === new URL(currentHref).origin) return true;
    return u.protocol === "https:" && ALL_PAYMENT_REDIRECT_HOSTS.includes(u.host);
  } catch {
    return false;
  }
}
