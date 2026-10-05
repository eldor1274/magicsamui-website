import type { Metadata } from "next";
import { headers } from "next/headers";
import BookingThemeRoot from "@/components/booking/BookingThemeRoot";
import { parseTheme } from "@/lib/booking/theme";
import ReturnStatus from "@/components/booking/return/ReturnStatus";
import { getBookingConfig, getPublicBookingConfig } from "@/lib/booking/config";
import { createRateLimiter, ipFromHeaders } from "@/lib/booking/routeUtils";
import { runStatus } from "@/lib/booking/status";
import type { ApiError, StatusResponse } from "@/lib/booking/types";

// Where Beam (or the simulated Beam page) sends the guest after paying.
// The status is verified on the server from the signed token - never from
// the query string alone.
export const metadata: Metadata = {
  title: "Booking status | Magic Suites & Villas",
  robots: { index: false, follow: false },
};

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

function one(v: string | string[] | undefined): string | null {
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === "string" && s.length > 0 && s.length <= 4096 ? s : null;
}

// Each load of this page may ask Beam for the payment status, so it shares
// the status API's brake: a per-IP limit, after which the client polls the
// (separately limited) API instead.
const isRateLimited = createRateLimiter(30, 60_000);

async function initialStatus(t: string | null, p: string | null): Promise<StatusResponse | ApiError | null> {
  if (!t) return null;
  if (isRateLimited(ipFromHeaders(await headers()))) {
    return { ok: false, error: "rate_limited", message: "We're checking this payment very often - please wait a moment and check again." };
  }
  try {
    const result = await runStatus({ t, p, l: null }, { config: getBookingConfig() });
    return result.body;
  } catch {
    return { ok: false, error: "payment_unavailable", message: "We couldn't check this payment right now. Please refresh in a moment." };
  }
}

export default async function BookingReturnPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const token = one(sp.t);
  const proof = one(sp.p);
  const config = getPublicBookingConfig();
  const initial = await initialStatus(token, proof);
  // ?theme wins; otherwise the theme the guest booked with (carried in the signed token).
  const theme = one(sp.theme) ? parseTheme(one(sp.theme)) : initial?.ok ? (initial.booking.theme ?? "magic") : "magic";

  return (
    <div className="mx-auto max-w-3xl px-3 py-6 sm:px-5 sm:py-10">
      <BookingThemeRoot theme={theme} className="rounded-(--bk-radius-card) p-3 sm:p-6">
        <ReturnStatus
          bookingRef={one(sp.ref)}
          token={token}
          proof={proof}
          initial={initial}
          paymentMode={config.paymentMode}
          theme={theme}
        />
      </BookingThemeRoot>
    </div>
  );
}
