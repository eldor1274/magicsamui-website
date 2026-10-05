// Cloudbeds room type IDs for the room slugs on this site. Shared by
// /api/rates (live "tonight" prices on room cards) and the booking preview.
// tuxedo-3br has no Cloudbeds room type yet, so it is not sold online.
export const ROOM_TYPE_TO_SLUG: Record<string, string> = {
  "462958": "honeymoon-suite",
  "462960": "sunrise-suite",
  "462961": "garden-suite",
  "462962": "seaview-suite",
  "462964": "seaview-2br",
  "575061": "tower-club-3br",
  "501425": "magic-1-villa",
  "464009": "tuxedo",
  "501423": "island-view-3br",
  "501424": "tuxedo-1br",
  "681024": "tuxedo-seaview-unit",
};

export const SLUG_TO_ROOM_TYPE: Record<string, string> = Object.fromEntries(
  Object.entries(ROOM_TYPE_TO_SLUG).map(([id, slug]) => [slug, id])
);

/** Public Cloudbeds property id (seen in the booking engine's analytics). */
export const CLOUDBEDS_PROPERTY_ID = "235064";

/**
 * Cloudbeds' own roomTypeName per room type, as its booking engine sends it in
 * GA4 item_name (captured from the live engine, Oct 2026). The booking preview
 * reports the same names so one item_id never shows under two names in GA4.
 */
export const CLOUDBEDS_ROOM_NAMES: Record<string, string> = {
  "462958": "Honeymoon Seaview Private Pool Suite",
  "462960": "Sunrise Seaview Private Jet Plunge Pool Suite",
  "462961": "Garden Suite",
  "462962": "Magic View Jet Plunge Pool Private Suite",
  "462964": "Magic SeaView Jet Plunge Pool Priv Suite 2BR",
  "575061": "Penthouse 3 bedroom with private pool&plunge",
  "501425": "Magic 1 villa",
  "464009": "Design Modern 2 Bedroom villa Seaview pool",
  "501423": "Island views & Sunrise jet plunge pool",
  "501424": "Design Modern 1 bedroom villa Seaview pool",
  "681024": "Private seaview modern villa unit",
};
