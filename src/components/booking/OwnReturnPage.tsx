import { headers } from "next/headers";
import BookingThemeRoot from "@/components/booking/BookingThemeRoot";
import ReturnStatus from "@/components/booking/return/ReturnStatus";
import { getPublicBookingConfig } from "@/lib/booking/config";
import { returnPageCheck } from "@/lib/booking/returnPageStatus";
import type { ReturnPageCheck } from "@/lib/booking/returnPageStatus";
import { createRateLimiter, ipFromHeaders } from "@/lib/booking/routeUtils";
import { parseTheme } from "@/lib/booking/theme";

// Server body of the return page, shared by /booking-preview/return and
// /booking/return. The payment page (Stripe Checkout, Beam, or the simulated /
// MOCK pages) sends the guest here. The status is verified on the server from
// the signed token - never from the query string alone - and, in the hold-first
// modes (Stripe, Beam), a paid payment is confirmed in Cloudbeds during this
// render. After a typo in the config a Beam booking is still checked here
// (returnPageStatus.ts, design S4.9). A Beam answer brings the Cloudbeds flags
// of the config that answered it (design S5.3: after a typo the public config
// is the locked one); every other answer keeps the public config's.

export type ReturnSearchParams = { [key: string]: string | string[] | undefined };

function one(v: string | string[] | undefined): string | null {
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === "string" && s.length > 0 && s.length <= 4096 ? s : null;
}

// Each load of this page may ask the payment provider for the status, so it
// shares the status API's brake: a per-IP limit, after which the client polls
// the (separately limited) API instead.
const isRateLimited = createRateLimiter(30, 60_000);

async function initialCheck(t: string | null, p: string | null, s: string | null): Promise<ReturnPageCheck | null> {
  if (!t) return null;
  if (isRateLimited(ipFromHeaders(await headers()))) {
    return { status: { ok: false, error: "rate_limited", message: "We're checking this payment very often - please wait a moment and check again." } };
  }
  // Request time (after the dynamic headers() read): the config, the Beam calls' deadline and runStatus.
  return returnPageCheck(t, p, s);
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
  const check = await initialCheck(token, proof, sessionId);
  const initial = check?.status ?? null;
  // A Beam answer: the flags of the Beam config that answered it (design S5.3); otherwise the public config's.
  const flags = check?.beamFlags ?? { cloudbedsWrites: config.cloudbedsWrites, sendsConfirmationEmail: config.sendsBookingConfirmationEmail };
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
          cloudbedsWrites={flags.cloudbedsWrites}
          sendsConfirmationEmail={flags.sendsConfirmationEmail}
          // The live /booking never shows a preview note from the CURRENT config on an unverified view
          // (an emergency stop makes it read "demo" while the guest may have paid).
          showUnverifiedPreviewNote={basePath !== "/booking"}
        />
      </BookingThemeRoot>
    </div>
  );
}
