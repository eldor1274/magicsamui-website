export interface Villa {
  slug: string;
  name: string;
  description: string;
  heroImage: { src: string; alt: string };
  roomSlugs: string[];
}

export const villas: Villa[] = [
  {
    slug: "magic-villa",
    name: "Magic Villa",
    description:
      "A 3-floor private villa split into 4 individually bookable suites — Honeymoon, Sunrise, Magic Seaview and Garden — each with its own pool or plunge pool. Book one suite for a private getaway, or combine several when travelling with family or friends.",
    heroImage: { src: "/images/home/Magic-Suites-50-2.jpg", alt: "Magic Villa exterior with private pool" },
    roomSlugs: ["honeymoon-suite", "sunrise-suite", "seaview-suite", "garden-suite"],
  },
  {
    slug: "tuxedo",
    name: "Tuxedo Villa",
    description:
      "A standalone modern villa with its own pool, jacuzzis and rooftop terrace — designed to blend into the natural landscape of Plai Laem. Book it as a private 1-bedroom stay, the classic 2-bedroom villa, or the full 3-bedroom experience with the lower cinema level.",
    heroImage: { src: "/images/tuxedo/DMZ_3612-1.jpg", alt: "Tuxedo villa exterior with private pool" },
    roomSlugs: ["tuxedo-1br", "tuxedo", "tuxedo-3br"],
  },
];

export function getVillaByRoomSlug(roomSlug: string): Villa | undefined {
  return villas.find((v) => v.roomSlugs.includes(roomSlug));
}
