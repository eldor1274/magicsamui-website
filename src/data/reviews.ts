export type ReviewPlatform = "booking" | "airbnb";

export interface Review {
  platform: ReviewPlatform;
  name: string;
  country: string;
  text: string;
}

export const reviewStats = {
  booking: {
    score: "9.8",
    label: "Exceptional",
    count: 64,
    url: "https://www.booking.com/hotel/th/magic-one-suites.en-gb.html",
  },
  airbnb: {
    score: "4.96",
    label: "Superhost",
    count: 280,
    years: 8,
    url: "https://www.airbnb.com/users/profile/1463186963221697726",
  },
};

// Per-suite Airbnb ratings, from the host profile listing cards.
export const airbnbRoomRatings: Record<string, { rating: string; count: number }> = {
  "honeymoon-suite": { rating: "4.97", count: 73 },
  "sunrise-suite": { rating: "4.95", count: 110 },
  "garden-suite": { rating: "5.0", count: 32 },
  "seaview-suite": { rating: "4.93", count: 28 },
  "seaview-2br": { rating: "4.88", count: 8 },
  tuxedo: { rating: "5.0", count: 22 },
  "tuxedo-1br": { rating: "5.0", count: 5 },
};

// Per-suite reviews shown on each room's own page (Airbnb reviews are
// per-listing, so they map naturally onto individual suites). Fill in as
// reviews are collected — a suite with no entry simply shows no block.
export const roomReviews: Record<string, Review[]> = {};

export const reviews: Review[] = [
  {
    platform: "booking",
    name: "Noel",
    country: "United States",
    text: "Amazing place! Very very clean. Great view and amenities. The owner was very helpful and kind! Definitely recommend for couples and anyone looking for an amazing villa in the mountains.",
  },
  {
    platform: "booking",
    name: "Zahraa",
    country: "Australia",
    text: "Would highly recommend this resort! The staff were very kind and helpful. We didn't have any issues. Our resort was very clean. The location of the resort was very well, close to a lot of different beaches and activity spots.",
  },
  {
    platform: "booking",
    name: "Olga",
    country: "Netherlands",
    text: "Very nice and modern villas, spacious rooms, beautiful view, free pick up and drop off upon arrival and departure.",
  },
  {
    platform: "booking",
    name: "Nicola",
    country: "United Kingdom",
    text: "New modern apartment built to a high specification. Good linen and standard of cleaning, pleasant planting in surroundings. Host Eldor is attentive and responsive to requests. Open view from the terrace, quiet area.",
  },
  {
    platform: "booking",
    name: "Simone",
    country: "Germany",
    text: "A very nice place to stay. The landlord was very friendly and helpful, he gave us lots of information about Samui. He was available at any time and we didn't miss anything. We felt very comfortable.",
  },
  {
    platform: "booking",
    name: "Daniel",
    country: "Australia",
    text: "Beautiful and unique condo. Spectacular view. I will definitely stay there again.",
  },
  {
    platform: "airbnb",
    name: "David",
    country: "Australia",
    text: "Absolutely amazing stay from start to finish. Eldor is an exceptional host and the accommodation is exactly as described. Highly recommended and we will be back.",
  },
  {
    platform: "airbnb",
    name: "Ugur",
    country: "",
    text: "Wonderful villa, super comfy place with great views. And the host Eldor is more than welcoming and available every time you need him. Great accommodation.",
  },
  {
    platform: "airbnb",
    name: "Memphis",
    country: "",
    text: "Highly recommend! The host was wonderful. I can't say enough good things about the service and the property was even more impressive.",
  },
];
