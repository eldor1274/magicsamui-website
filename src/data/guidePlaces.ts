// Curated from Eldor's shared Google Maps lists (checked 2026-08-01).
// Closed places from the lists are deliberately left out.

export interface GuidePlace {
  name: string;
  rating: string;
  reviews: number;
  type: string;
  price?: string;
  // Road distance from Magic Suites, computed from each place's real
  // coordinates (OpenStreetMap/Google) via OSRM driving routes.
  distanceKm: number;
  driveMin: number;
}

export function mapsSearchUrl(name: string) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
    `${name} Koh Samui`
  )}`;
}

// 12Go route pages show live timetables and prices; the z/sub_id params
// credit bookings to our partner account.
export function twelveGoRouteUrl(fromSlug: string, toSlug: string) {
  return `https://12go.asia/en/travel/${fromSlug}/${toSlug}?z=15319268&sub_id=magicsamui-guide`;
}

export const guideLists = {
  breakfast: "https://maps.app.goo.gl/g55SrEsRF1p5zNi97",
  lunchDinner: "https://maps.app.goo.gl/1P682EsVwSnPadGaA",
  beachesTemples: "https://maps.app.goo.gl/9R97PaJpoDtLX4Ef8",
};

// Each list is ordered nearest to furthest from Magic Suites.
export const breakfastSpots: GuidePlace[] = [
  { name: "Em's Cafe", rating: "4.8", reviews: 136, type: "Cafe", price: "฿200–400", distanceKm: 0.6, driveMin: 2 },
  { name: "thirteenroots", rating: "4.8", reviews: 287, type: "Restaurant", price: "฿400–600", distanceKm: 1.7, driveMin: 3 },
  { name: "SOL Bake.Brew.Bites", rating: "4.7", reviews: 639, type: "Cafe", price: "฿200–400", distanceKm: 2, driveMin: 3 },
  { name: "Nomad Brunch & Brew", rating: "4.8", reviews: 169, type: "Coffee shop", price: "฿200–400", distanceKm: 2.7, driveMin: 4 },
  { name: "Kirati", rating: "4.2", reviews: 318, type: "Hotel restaurant", distanceKm: 2.7, driveMin: 5 },
];

export const lunchDinnerSpots: GuidePlace[] = [
  { name: "Maithy Pool Lounge & Restaurant", rating: "4.8", reviews: 965, type: "Restaurant", distanceKm: 1.5, driveMin: 3 },
  { name: "The Cocoon — Samui Viewpoint", rating: "4.7", reviews: 10297, type: "Restaurant", price: "฿400–1,600", distanceKm: 3.9, driveMin: 7 },
  { name: "Baci Italian Restaurant", rating: "4.9", reviews: 345, type: "Italian", price: "฿400–1,200", distanceKm: 4.2, driveMin: 6 },
  { name: "Federico's", rating: "4.8", reviews: 591, type: "Italian", price: "฿200–800", distanceKm: 6.3, driveMin: 9 },
];

export const beaches: GuidePlace[] = [
  { name: "Choeng Mon Beach", rating: "4.5", reviews: 1484, type: "Beach", distanceKm: 1.9, driveMin: 4 },
  { name: "Thongson Beach", rating: "4.3", reviews: 493, type: "Beach", distanceKm: 3.6, driveMin: 7 },
  { name: "Chaweng Beach", rating: "4.3", reviews: 2146, type: "Beach", distanceKm: 5.3, driveMin: 8 },
  { name: "Coral Cove Beach", rating: "4.4", reviews: 1731, type: "Beach", distanceKm: 11.5, driveMin: 14 },
  { name: "Silver Beach", rating: "4.2", reviews: 2860, type: "Beach", distanceKm: 13.1, driveMin: 16 },
  { name: "Crystal Bay Beach Resort", rating: "4.4", reviews: 2391, type: "Beach resort", distanceKm: 13.1, driveMin: 16 },
  { name: "Lamai Beach", rating: "4.4", reviews: 3720, type: "Beach", distanceKm: 16.5, driveMin: 19 },
  { name: "Nathon Beach", rating: "4.1", reviews: 202, type: "Beach", distanceKm: 23.3, driveMin: 24 },
  { name: "Nikki Beach Resort & Spa Koh Samui", rating: "4.5", reviews: 2173, type: "Beach club & resort", distanceKm: 29.3, driveMin: 30 },
];

export const templesAndSights: GuidePlace[] = [
  { name: "Wat Plai Laem", rating: "4.7", reviews: 8260, type: "Temple", distanceKm: 1.2, driveMin: 3 },
  { name: "Wat Phra Yai (Big Buddha)", rating: "4.5", reviews: 11247, type: "Temple", distanceKm: 2, driveMin: 4 },
  { name: "Hin Ta Hin Yai", rating: "4.2", reviews: 11123, type: "Rock formations", distanceKm: 18.7, driveMin: 23 },
  { name: "Wat Khunaram (Phra Wihan Luang Pho Daeng)", rating: "4.5", reviews: 2479, type: "Temple", distanceKm: 23.3, driveMin: 26 },
  { name: "Wat Phra Chedi Laem Sor", rating: "4.4", reviews: 1480, type: "Temple", distanceKm: 28.8, driveMin: 34 },
  { name: "Chomview Restaurant", rating: "4.4", reviews: 20, type: "Restaurant", price: "฿400–600", distanceKm: 32.1, driveMin: 38 },
  { name: "Wat Teepangkorn", rating: "4.5", reviews: 90, type: "Temple", distanceKm: 32.4, driveMin: 40 },
];
