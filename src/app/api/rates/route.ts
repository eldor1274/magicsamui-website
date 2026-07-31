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
      const existing = rates[slug];
      const available = plan.roomsAvailable > 0;
      // keep the lowest rate per room; available if any plan has availability
      if (!existing || plan.roomRate < existing.price) {
        rates[slug] = { price: plan.roomRate, available: existing?.available || available };
      } else if (available && !existing.available) {
        existing.available = true;
      }
    }

    return Response.json(rates, {
      headers: { "Cache-Control": "s-maxage=900, stale-while-revalidate=300" },
    });
  } catch {
    return Response.json({}, { status: 200 });
  }
}
