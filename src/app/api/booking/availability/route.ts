import type { NextRequest } from "next/server";
import { InventoryUnavailableError, SEARCH_CACHE_TTL_MS, alertNoBaseRateAll, buildOffers, getInventory } from "@/lib/booking/availability";
import { PROMO_CODE, getBookingConfig, getInventoryConfig, getPublicBookingConfig } from "@/lib/booking/config";
import { validationLimits } from "@/lib/booking/checkout";
import { nightsBetween } from "@/lib/booking/dates";
import { resolvePromo } from "@/lib/booking/quote";
import { apiError, clientIp, createRateLimiter, json, logEvent } from "@/lib/booking/routeUtils";
import { getStripeDeps } from "@/lib/booking/runtime";
import type { AvailabilityResponse } from "@/lib/booking/types";
import { parseSearch } from "@/lib/booking/validate";

// Booking preview: availability + priced offers for a stay. Read-only.
// `fresh=1` skips the short per-instance Cloudbeds cache (used right after a
// checkout conflict, so the guest sees what the checkout just saw). The
// Cloudbeds key is shared with /api/rates and the owner's cron, so on top of
// the per-IP limit every preview call to Cloudbeds draws on a small
// per-instance budget (cloudbedsProvider.ts), and `fresh=1` is honoured only
// a few times per IP - otherwise the cached answer is served. On the production
// deployment a LOCKED config (nobody can pay) answers 503 without calling
// Cloudbeds at all.
const isRateLimited = createRateLimiter(60, 60_000);
const isFreshLimited = createRateLimiter(3, 10 * 60_000);

export async function GET(request: NextRequest) {
  const ip = clientIp(request);
  if (isRateLimited(ip)) {
    return apiError(429, "rate_limited", "Too many searches - please wait a moment and try again.");
  }
  const sp = request.nextUrl.searchParams;
  const parsed = parseSearch(
    { checkin: sp.get("checkin"), checkout: sp.get("checkout"), adults: sp.get("adults"), promo: sp.get("promo") },
    validationLimits(Date.now()),
  );
  if (!parsed.ok) return apiError(400, "invalid_request", parsed.issues[0] ?? "Invalid search.", parsed.issues);
  const search = parsed.value;

  const inventoryConfig = getInventoryConfig();
  const config = getPublicBookingConfig();
  // A locked preview on the production deployment (the default there: no booking env) can't book anything,
  // so it never spends the Cloudbeds read key shared with /api/rates and the owner's cron.
  if (config.paymentStatus === "locked" && process.env.VERCEL_ENV === "production") {
    return apiError(503, "payment_unavailable", "Online booking on this page is paused right now. Please book on our main booking page or message us on WhatsApp.");
  }
  // Stripe: promo codes are off (no Cloudbeds rate plan behind them yet), so a
  // code from an old link (?promo=DIRECT) is ignored instead of shown as an error.
  const promo = inventoryConfig.provider === "stripe" && inventoryConfig.promoPct === 0 ? null : resolvePromo(search.promo, inventoryConfig.promoPct, PROMO_CODE);
  let result: Awaited<ReturnType<typeof getInventory>>;
  try {
    result = await getInventory(search.checkIn, search.checkOut, inventoryConfig, {
      // Simulated stand-in data is shown only while payments are simulated
      // (demo, or locked so nobody can pay); in any Beam mode a guest must
      // never see - and then pay - made-up prices.
      allowDemoFallback: config.paymentMode === "demo" || config.paymentMode === "stripe-mock",
      cacheTtlMs: sp.get("fresh") === "1" && !isFreshLimited(ip) ? 0 : SEARCH_CACHE_TTL_MS,
      onFallback: (e) => logEvent("cloudbeds_fallback", { error: e instanceof Error ? e.message : String(e) }),
      // Stripe sells the base rate only: when that leaves no room at all, the owner is told (the alerter is built only then).
      ...(inventoryConfig.provider === "stripe"
        ? {
            onNoBaseRateAll: async (slugs: string[]) => {
              const deps = getStripeDeps(getBookingConfig());
              if (deps) await alertNoBaseRateAll(deps.alert, slugs, search.checkIn, search.checkOut);
            },
          }
        : {}),
    });
  } catch (e) {
    if (!(e instanceof InventoryUnavailableError)) throw e;
    logEvent("availability_unavailable", { mode: config.paymentMode, error: e.message });
    return apiError(503, "upstream_error", "We could not load live availability just now. Please try again in a moment.");
  }
  const { inventory, dataSource } = result;

  const body: AvailabilityResponse = {
    ok: true,
    search: { ...search, promo: promo?.code },
    nights: nightsBetween(search.checkIn, search.checkOut),
    dataSource,
    config,
    promo,
    offers: buildOffers(inventory, search.adults, inventoryConfig.ratePlans),
    generatedAt: new Date().toISOString(),
  };
  return json(body);
}
