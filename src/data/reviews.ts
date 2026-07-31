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
  // airbnb: added once the Airbnb listing details are available
};

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
];
