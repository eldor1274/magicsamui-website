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
