import { headers } from "next/headers";
import BookingThemeRoot from "@/components/booking/BookingThemeRoot";
import ReturnStatus from "@/components/booking/return/ReturnStatus";
import { getFulfilmentConfig, getPublicBookingConfig } from "@/lib/booking/config";
import { createRateLimiter, ipFromHeaders } from "@/lib/booking/routeUtils";
import { providerDepsFor } from "@/lib/booking/runtime";
import { runStatus } from "@/lib/booking/status";
import { parseTheme } from "@/lib/booking/theme";
import type { ApiError, StatusResponse } from "@/lib/booking/types";

// Server body of the return page, shared by /booking-preview/return and
// /booking/return. The payment page (Stripe Checkout, Beam, or the simulated /
// MOCK pages) sends the guest here. The status is verified on the server from
// the signed token - never from the query string alone - and, in the hold-first
// modes (Stripe, Beam), a paid payment is confirmed in Cloudbeds during this
// render.

export type ReturnSearchParams = { [key: string]: string | string[] | undefined };

function one(v: string | string[] | undefined): string | null {
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === "string" && s.length > 0 && s.length <= 4096 ? s : null;
}

// Each load of this page may ask the payment provider for the status, so it
// shares the status API's brake: a per-IP limit, after which the client polls
// the (separately limited) API instead.
const isRateLimited = createRateLimiter(30, 60_000);
/** Every Beam call of this render's status check ends by this long after it started (the pages' maxDuration minus a margin; Stripe ignores it). */
const STATUS_BUDGET_MS = 25_000;

async function initialStatus(t: string | null, p: string | null, s: string | null): Promise<StatusResponse | ApiError | null> {
  if (!t) return null;
  if (isRateLimited(ipFromHeaders(await headers()))) {
    return { ok: false, error: "rate_limited", message: "We're checking this payment very often - please wait a moment and check again." };
  }
  // Request time (after the dynamic headers() read).
  const deadlineMs = Date.now() + STATUS_BUDGET_MS;
  try {
    // getFulfilmentConfig: the emergency stop (BOOKING_ALLOW_LIVE_PAYMENTS=false) blocks NEW charges only;
    // a guest who already paid must still see (and get) a confirmed booking.
    // The provider's deps are picked by the booking's provider, exactly as the status API does.
    const config = getFulfilmentConfig();
    const result = await runStatus({ t, p, l: null, s }, { config, providerDeps: providerDepsFor(config, process.env, { deadlineMs }) });
    return result.body;
  } catch {
    return { ok: false, error: "payment_unavailable", message: "We couldn't check this payment right now. Please refresh in a moment." };
  }
}

export default async function OwnReturnPage({
  searchParams,
  basePath,
}: {
  searchParams: ReturnSearchParams;
  basePath: "/booking" | "/booking-preview";
}) {
  const sp = searchParams;
  const token = one(sp.t);
  const proof = one(sp.p);
  const sessionId = one(sp.session_id);
  const config = getPublicBookingConfig();
  const initial = await initialStatus(token, proof, sessionId);
  // ?theme wins; otherwise the theme the guest booked with (carried in the signed token).
  const theme = one(sp.theme) ? parseTheme(one(sp.theme)) : initial?.ok ? (initial.booking.theme ?? "magic") : "magic";

  return (
    <div className="booking-return mx-auto max-w-3xl px-3 py-6 sm:px-5 sm:py-10">
      <BookingThemeRoot theme={theme} className="rounded-(--bk-radius-card) p-3 sm:p-6">
        <ReturnStatus
          bookingRef={one(sp.ref)}
          token={token}
          proof={proof}
          initial={initial}
          paymentMode={initial?.ok ? initial.paymentMode : config.paymentMode}
          theme={theme}
          sessionId={sessionId}
          bookingPath={basePath}
          cloudbedsWrites={config.cloudbedsWrites}
          sendsConfirmationEmail={config.sendsBookingConfirmationEmail}
          // The live /booking never shows a preview note from the CURRENT config on an unverified view
          // (an emergency stop makes it read "demo" while the guest may have paid).
          showUnverifiedPreviewNote={basePath !== "/booking"}
        />
      </BookingThemeRoot>
    </div>
  );
}
