import type { NextRequest } from "next/server";
import { InventoryUnavailableError, SEARCH_CACHE_TTL_MS, buildOffers, getInventory } from "@/lib/booking/availability";
import { PROMO_CODE, getInventoryConfig, getPublicBookingConfig } from "@/lib/booking/config";
import { validationLimits } from "@/lib/booking/checkout";
import { nightsBetween } from "@/lib/booking/dates";
import { resolvePromo } from "@/lib/booking/quote";
import { apiError, clientIp, createRateLimiter, json, logEvent } from "@/lib/booking/routeUtils";
import type { AvailabilityResponse } from "@/lib/booking/types";
import { parseSearch } from "@/lib/booking/validate";

// Booking preview: availability + priced offers for a stay. Read-only.
// `fresh=1` skips the short per-instance Cloudbeds cache (used right after a
// checkout conflict, so the guest sees what the checkout just saw). The
// Cloudbeds key is shared with /api/rates and the owner's cron, so on top of
// the per-IP limit every preview call to Cloudbeds draws on a small
// per-instance budget (cloudbedsProvider.ts), and `fresh=1` is honoured only
// a few times per IP - otherwise the cached answer is served.
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
  const promo = resolvePromo(search.promo, inventoryConfig.promoPct, PROMO_CODE);
  let result: Awaited<ReturnType<typeof getInventory>>;
  try {
    result = await getInventory(search.checkIn, search.checkOut, inventoryConfig, {
      // Simulated stand-in data is shown only while payments are simulated
      // (demo, or locked so nobody can pay); in any Beam mode a guest must
      // never see - and then pay - made-up prices.
      allowDemoFallback: config.paymentMode === "demo",
      cacheTtlMs: sp.get("fresh") === "1" && !isFreshLimited(ip) ? 0 : SEARCH_CACHE_TTL_MS,
      onFallback: (e) => logEvent("cloudbeds_fallback", { error: e instanceof Error ? e.message : String(e) }),
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
    offers: buildOffers(inventory, search.adults),
    generatedAt: new Date().toISOString(),
  };
  return json(body);
}
