// Curated from Eldor's shared Google Maps lists (checked 2026-08-01).
// Closed places from the lists are deliberately left out.

export interface GuidePlace {
  name: string;
  rating: string;
  reviews: number;
  type: string;
  price?: string;
}

export function mapsSearchUrl(name: string) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
    `${name} Koh Samui`
  )}`;
}

export const guideLists = {
  breakfast: "https://maps.app.goo.gl/g55SrEsRF1p5zNi97",
  lunchDinner: "https://maps.app.goo.gl/1P682EsVwSnPadGaA",
  beachesTemples: "https://maps.app.goo.gl/9R97PaJpoDtLX4Ef8",
};

export const breakfastSpots: GuidePlace[] = [
  { name: "thirteenroots", rating: "4.8", reviews: 287, type: "Restaurant", price: "฿400–600" },
  { name: "Em's Cafe", rating: "4.8", reviews: 136, type: "Cafe", price: "฿200–400" },
  { name: "Nomad Brunch & Brew", rating: "4.8", reviews: 169, type: "Coffee shop", price: "฿200–400" },
  { name: "SOL Bake.Brew.Bites", rating: "4.7", reviews: 639, type: "Cafe", price: "฿200–400" },
  { name: "Kirati", rating: "4.2", reviews: 318, type: "Hotel restaurant" },
];

export const lunchDinnerSpots: GuidePlace[] = [
  { name: "Baci Italian Restaurant", rating: "4.9", reviews: 345, type: "Italian", price: "฿400–1,200" },
  { name: "Federico's", rating: "4.8", reviews: 591, type: "Italian", price: "฿200–800" },
  { name: "Maithy Pool Lounge & Restaurant", rating: "4.8", reviews: 965, type: "Restaurant" },
  { name: "The Cocoon — Samui Viewpoint", rating: "4.7", reviews: 10297, type: "Restaurant", price: "฿400–1,600" },
];

export const beaches: GuidePlace[] = [
  { name: "Choeng Mon Beach", rating: "4.5", reviews: 1484, type: "Beach" },
  { name: "Lamai Beach", rating: "4.4", reviews: 3720, type: "Beach" },
  { name: "Coral Cove Beach", rating: "4.4", reviews: 1731, type: "Beach" },
  { name: "Thongson Beach", rating: "4.3", reviews: 493, type: "Beach" },
  { name: "Silver Beach", rating: "4.2", reviews: 2860, type: "Beach" },
  { name: "Nathon Beach", rating: "4.1", reviews: 202, type: "Beach" },
  { name: "Thongson Bay Beach", rating: "3.8", reviews: 58, type: "Beach" },
  { name: "Crystal Bay Beach Resort", rating: "4.4", reviews: 2391, type: "Beach resort" },
  { name: "Nikki Beach Resort & Spa Koh Samui", rating: "4.5", reviews: 2173, type: "Beach club & resort" },
];

export const templesAndSights: GuidePlace[] = [
  { name: "Wat Phra Yai (Big Buddha)", rating: "4.5", reviews: 11247, type: "Temple" },
  { name: "Wat Plai Laem", rating: "4.7", reviews: 8260, type: "Temple" },
  { name: "Wat Khunaram (Phra Wihan Luang Pho Daeng)", rating: "4.5", reviews: 2479, type: "Temple" },
  { name: "Wat Phra Chedi Laem Sor", rating: "4.4", reviews: 1480, type: "Temple" },
  { name: "Wat Teepangkorn", rating: "4.5", reviews: 90, type: "Temple" },
  { name: "Hin Ta Hin Yai", rating: "4.2", reviews: 11123, type: "Rock formations" },
  { name: "Chomview Restaurant", rating: "4.4", reviews: 20, type: "Restaurant", price: "฿400–600" },
];
