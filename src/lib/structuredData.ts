import { site } from "@/data/site";
import type { Room } from "@/data/rooms";

const BASE = `https://${site.domain}`;

// Coordinates from the resort's own Google Maps listing
// ("Magic Suites - Samui Luxury Private Pool Villas").
const GEO = { latitude: 9.5639124, longitude: 100.0690455 };

export function resortJsonLd() {
  return {
    "@context": "https://schema.org",
    "@type": "Resort",
    "@id": `${BASE}/#resort`,
    name: site.name,
    url: BASE,
    image: `${BASE}/images/home/Magic-Suites-50-2.jpg`,
    description:
      "Private pool villas and suites on a hillside overlooking the gulf of Thailand in Koh Samui, minutes from Choeng Mon Beach.",
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
    priceRange: "฿3,000–฿40,000",
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
  return {
    "@context": "https://schema.org",
    "@type": "HotelRoom",
    name: room.name,
    url: `${BASE}/rooms/${room.slug}`,
    image: `${BASE}${room.heroImage.src}`,
    description: room.summary,
    occupancy: { "@type": "QuantitativeValue", maxValue: room.guests },
    floorSize: { "@type": "QuantitativeValue", value: room.area.sqm, unitCode: "MTK" },
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
