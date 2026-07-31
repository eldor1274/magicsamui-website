const ROOM_TYPE_TO_SLUG: Record<string, string> = {
  "462958": "honeymoon-suite",
  "462960": "sunrise-suite",
  "462961": "garden-suite",
  "462962": "seaview-suite",
  "462964": "seaview-2br",
  "464009": "tuxedo",
  "501423": "island-view-3br",
  "501424": "tuxedo-1br",
};

interface RatePlan {
  roomTypeID: string;
  roomRate: number;
  roomsAvailable: number;
  isDerived: boolean;
}

export async function GET() {
  const apiKey = process.env.CLOUDBEDS_API_KEY;
  if (!apiKey) {
    return Response.json({}, { status: 200 });
  }

  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

  try {
    const res = await fetch(
      `https://api.cloudbeds.com/api/v1.2/getRatePlans?startDate=${today}&endDate=${tomorrow}`,
      {
        headers: { "x-api-key": apiKey },
        next: { revalidate: 900 },
      }
    );
    if (!res.ok) throw new Error(`Cloudbeds ${res.status}`);
    const json = await res.json();
    const plans: RatePlan[] = json.data ?? [];

    const rates: Record<string, { price: number; available: boolean }> = {};
    for (const plan of plans) {
      const slug = ROOM_TYPE_TO_SLUG[plan.roomTypeID];
      if (!slug || !plan.roomRate) continue;
      const available = plan.roomsAvailable > 0;
      // price comes from the base rate only (derived plans are discounts:
      // direct-booking, non-refundable, agency rates, etc.)
      if (!plan.isDerived) {
        rates[slug] = { price: plan.roomRate, available: rates[slug]?.available || available };
      } else if (rates[slug] && available && !rates[slug].available) {
        rates[slug].available = true;
      }
    }

    return Response.json(rates, {
      headers: { "Cache-Control": "s-maxage=900, stale-while-revalidate=300" },
    });
  } catch {
    return Response.json({}, { status: 200 });
  }
}
