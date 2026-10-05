import type { Metadata } from "next";
import BookingThemeRoot from "@/components/booking/BookingThemeRoot";
import { parseTheme } from "@/lib/booking/theme";
import ReturnStatus from "@/components/booking/return/ReturnStatus";
import { getBookingConfig, getPublicBookingConfig } from "@/lib/booking/config";
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

async function initialStatus(t: string | null, p: string | null): Promise<StatusResponse | ApiError | null> {
  if (!t) return null;
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

  return (
    <div className="mx-auto max-w-3xl px-3 py-6 sm:px-5 sm:py-10">
      <BookingThemeRoot theme={parseTheme(one(sp.theme))} className="rounded-(--bk-radius-card) p-3 sm:p-6">
        <ReturnStatus
          bookingRef={one(sp.ref)}
          token={token}
          proof={proof}
          initial={await initialStatus(token, proof)}
          paymentMode={config.paymentMode}
        />
      </BookingThemeRoot>
    </div>
  );
}
