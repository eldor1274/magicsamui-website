// Relative .ts imports (not "@/"), so node --test can load this module too.
import { CLOUDBEDS_ROOM_NAMES, SLUG_TO_ROOM_TYPE } from "../data/cloudbeds.ts";
import { rooms, type Room } from "../data/rooms.ts";
import { site } from "../data/site.ts";
import { villas } from "../data/villas.ts";
import { ROOM_UNITS, UNIT_NAMES } from "./booking/catalogue.ts";

const BASE = `https://${site.domain}`;

const thb = (n: number) => `฿${n.toLocaleString("en-US")}`;
const lowestThb = Math.min(...rooms.map((r) => r.priceThb));
const highestThb = Math.max(...rooms.map((r) => r.priceThb));

/**
 * The villa a room type takes over completely (every physical unit of that building), or
 * undefined. Today: magic-1-villa (all four Magic Villa suites) and tuxedo-3br (the Tuxedo
 * villa plus its lower Seaview Unit). Those are a whole house to rent, not a hotel room.
 */
export function wholeVillaOf(slug: string) {
  const units = ROOM_UNITS[slug] ?? [];
  return villas.find((villa) => {
    const villaUnits = new Set(villa.roomSlugs.flatMap((s) => ROOM_UNITS[s] ?? []));
    return villaUnits.size > 0 && [...villaUnits].every((u) => units.includes(u));
  });
}

/**
 * Sea view only where the room's own copy (or its Cloudbeds room-type name, e.g. "Design Modern
 * 2 Bedroom villa Seaview pool") says so: today that is every unit.
 */
const SEA_VIEW = /\bsea[ -]?views?\b|\boverlooking the sea\b|\bfacing the sea\b/i;
export function hasSeaView(room: Room): boolean {
  const cloudbedsName = CLOUDBEDS_ROOM_NAMES[SLUG_TO_ROOM_TYPE[room.slug] ?? ""] ?? "";
  return SEA_VIEW.test([room.name, room.summary, ...room.description, cloudbedsName].join(" "));
}

const feature = (name: string) => ({ "@type": "LocationFeatureSpecification", name, value: true });

// Coordinates from the resort's own Google Maps listing
// ("Magic Suites - Samui Luxury Private Pool Villas").
const GEO = { latitude: 9.5639124, longitude: 100.0690455 };

export function resortJsonLd() {
  return {
    "@context": "https://schema.org",
    "@type": "Resort",
    "@id": `${BASE}/#resort`,
    name: site.name,
    legalName: site.legalName,
    url: BASE,
    image: `${BASE}/images/home/Magic-Suites-50-2.jpg`,
    description:
      "Two villas and five private suites, most with a private pool, on a hillside overlooking the gulf of Thailand in Koh Samui, minutes from Choeng Mon Beach. From 1-bedroom suites to 3-bedroom stays for 6 and the entire Magic Villa: 5 bedrooms, 4 private pools, up to 10 guests.",
    // Physical units that can be let at the same time: Magic Villa's 4 suites, the Tuxedo villa
    // and its lower Seaview Unit (the bigger stays are combinations of these).
    numberOfRooms: Object.keys(UNIT_NAMES).length,
    address: {
      "@type": "PostalAddress",
      streetAddress: "Bo Put Moo 5, 51/140",
      addressLocality: "Ko Samui",
      addressRegion: "Surat Thani",
      postalCode: "84320",
      addressCountry: "TH",
    },
    geo: { "@type": "GeoCoordinates", ...GEO },
    hasMap: site.mapsUrl,
    telephone: site.phones[0].tel,
    email: site.email,
    priceRange: `${thb(lowestThb)}–${thb(highestThb)}`,
    checkinTime: "15:00",
    checkoutTime: "11:00",
    petsAllowed: false,
    sameAs: [
      site.instagram,
      site.facebook,
      site.tiktok,
      "https://www.booking.com/hotel/th/magic-one-suites.en-gb.html",
      "https://www.airbnb.com/users/profile/1463186963221697726",
    ],
  };
}

export function roomJsonLd(room: Room) {
  const amenities = [
    ...(room.hasPool !== false ? [feature("Private pool")] : []),
    ...(hasSeaView(room) ? [feature("Sea view")] : []),
  ];
  return {
    "@context": "https://schema.org",
    // A stay that takes a whole villa is a house; a suite or a combination of suites stays a room.
    "@type": wholeVillaOf(room.slug) ? "House" : "HotelRoom",
    name: room.name,
    url: `${BASE}/rooms/${room.slug}`,
    image: `${BASE}${room.heroImage.src}`,
    description: room.summary,
    numberOfBedrooms: room.bedrooms,
    occupancy: { "@type": "QuantitativeValue", maxValue: room.guests },
    floorSize: { "@type": "QuantitativeValue", value: room.area.sqm, unitCode: "MTK" },
    ...(amenities.length > 0 ? { amenityFeature: amenities } : {}),
    containedInPlace: { "@id": `${BASE}/#resort` },
    offers: {
      "@type": "Offer",
      price: room.priceThb,
      priceCurrency: "THB",
      availability: "https://schema.org/InStock",
      url: `${BASE}/rooms/${room.slug}`,
    },
  };
}

export function blogPostJsonLd(post: {
  slug: string;
  title: string;
  description: string;
  heroImage: string | null;
}) {
  return {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: post.title,
    description: post.description,
    url: `${BASE}/blog/${post.slug}`,
    mainEntityOfPage: `${BASE}/blog/${post.slug}`,
    ...(post.heroImage ? { image: `${BASE}${post.heroImage}` } : {}),
    author: { "@type": "Organization", name: site.name, url: BASE },
    publisher: {
      "@type": "Organization",
      name: site.name,
      url: BASE,
    },
  };
}

export function breadcrumbJsonLd(items: { name: string; path: string }[]) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: item.name,
      item: `${BASE}${item.path}`,
    })),
  };
}
