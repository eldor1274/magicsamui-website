import type { NextRequest } from "next/server";
import { buildOffers, getInventory } from "@/lib/booking/availability";
import { PROMO_CODE, getInventoryConfig, getPublicBookingConfig } from "@/lib/booking/config";
import { validationLimits } from "@/lib/booking/checkout";
import { nightsBetween } from "@/lib/booking/dates";
import { resolvePromo } from "@/lib/booking/quote";
import { apiError, clientIp, createRateLimiter, json, logEvent } from "@/lib/booking/routeUtils";
import type { AvailabilityResponse } from "@/lib/booking/types";
import { parseSearch } from "@/lib/booking/validate";

// Booking preview: availability + priced offers for a stay. Read-only.
const isRateLimited = createRateLimiter(60, 60_000);

export async function GET(request: NextRequest) {
  if (isRateLimited(clientIp(request))) {
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
  const promo = resolvePromo(search.promo, inventoryConfig.promoPct, PROMO_CODE);
  const { inventory, dataSource } = await getInventory(search.checkIn, search.checkOut, inventoryConfig, {
    onFallback: (e) => logEvent("cloudbeds_fallback", { error: e instanceof Error ? e.message : String(e) }),
  });

  const body: AvailabilityResponse = {
    ok: true,
    search: { ...search, promo: promo?.code },
    nights: nightsBetween(search.checkIn, search.checkOut),
    dataSource,
    config: getPublicBookingConfig(),
    promo,
    offers: buildOffers(inventory, search.adults),
    generatedAt: new Date().toISOString(),
  };
  return json(body);
}
