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

// Per-suite Airbnb ratings and listing URLs, verified against the host
// profile listing cards on 2026-08-01.
export const airbnbRoomRatings: Record<
  string,
  { rating: string; count: number; url: string }
> = {
  "honeymoon-suite": { rating: "4.97", count: 73, url: "https://www.airbnb.com/rooms/28196344" },
  "sunrise-suite": { rating: "4.95", count: 110, url: "https://www.airbnb.com/rooms/29005147" },
  "garden-suite": { rating: "5.0", count: 32, url: "https://www.airbnb.com/rooms/29254478" },
  "seaview-suite": { rating: "4.93", count: 28, url: "https://www.airbnb.com/rooms/28832401" },
  "seaview-2br": { rating: "4.88", count: 8, url: "https://www.airbnb.com/rooms/34888112" },
  tuxedo: { rating: "5.0", count: 22, url: "https://www.airbnb.com/rooms/742977649837038413" },
  "tuxedo-1br": { rating: "5.0", count: 5, url: "https://www.airbnb.com/rooms/41217397" },
};

// Per-suite reviews shown on each room's own page (Airbnb reviews are
// per-listing, so they map naturally onto individual suites).
export const roomReviews: Record<string, Review[]> = {
  "honeymoon-suite": [
    {
      platform: "airbnb",
      name: "Léa",
      country: "",
      text: "A wonderful stay, perfect for a romantic getaway. The place is cozy, well located and ideal to fully enjoy the island. Highly recommended!",
    },
    {
      platform: "airbnb",
      name: "Yonelvis",
      country: "United States",
      text: "I had a spectacular stay at this villa in Koh Samui! The views were incredible, and the house was clean with beautiful furniture. The pictures don't do it justice at all. Our host, Eldor, was fantastic — he attended to all our needs and was easy to communicate with.",
    },
    {
      platform: "airbnb",
      name: "Tendak",
      country: "Switzerland",
      text: "Eldor and his colleague are super hosts and put their heart and soul into their work. We were picked up at the airport at check-in and taken there at check-out. The communication was very fast and pragmatic.",
    },
  ],
  "sunrise-suite": [
    {
      platform: "airbnb",
      name: "Suthirath",
      country: "United States",
      text: "This was a beautiful location with a fantastic view of the island. The first thing we noticed was how attentive Eldor is as a host. He greeted us in person with his staff upon arrival.",
    },
    {
      platform: "airbnb",
      name: "Waleed",
      country: "",
      text: "Outstanding welcome and flexible check-in delivered by very genuine guys with a very calming presence. The place is just like the pictures, very well maintained and with just the right amount of furniture.",
    },
    {
      platform: "airbnb",
      name: "Ellie-Mae",
      country: "",
      text: "Fantastic place. It's a must visit for a relaxing stay. Thanks so much!!",
    },
  ],
  "garden-suite": [
    {
      platform: "airbnb",
      name: "Lily",
      country: "Israel",
      text: "Great place, will definitely come back. The suite is beautiful, very comfortable, smells great and really clean. Private and quiet location, amazing view, perfect sunrise and sunset. Eldor is a real super-host!",
    },
    {
      platform: "airbnb",
      name: "Sayantan",
      country: "",
      text: "Eldor is a very professional host, his property is luxurious with state-of-the-art facilities. Me and my friends absolutely enjoyed our time here.",
    },
    {
      platform: "airbnb",
      name: "David",
      country: "United Arab Emirates",
      text: "Best host so far, highly recommend staying at his places.",
    },
  ],
  "seaview-suite": [
    {
      platform: "airbnb",
      name: "Diego",
      country: "United States",
      text: "Beautiful villa, very peaceful and comfortable. The area was private and not too high in the hills so it was perfect. Very clean and perfect villa!",
    },
    {
      platform: "airbnb",
      name: "Tyler",
      country: "",
      text: "Eldor was great and made me feel right at home. Very friendly and accommodating and went out of his way to make sure things were perfect!",
    },
    {
      platform: "airbnb",
      name: "Doortje",
      country: "",
      text: "We loved our stay. Everything was very beautiful and clean, and the villa had a beautiful view.",
    },
  ],
  "seaview-2br": [
    {
      platform: "airbnb",
      name: "Abraham",
      country: "United States",
      text: "We stayed one night at this place and it was awesome. Clean, private, and completely worth the money we paid. The host was friendly and very helpful. We highly recommend this place.",
    },
    {
      platform: "airbnb",
      name: "Vlad",
      country: "",
      text: "I had a wonderful stay at this magnificent villa. Perfect view, clean, and beautiful interior. I was as comfortable as possible at this place. Eldor and his family are wonderful and very kind people.",
    },
    {
      platform: "airbnb",
      name: "Aidan",
      country: "United States",
      text: "Lovely as always.",
    },
  ],
  tuxedo: [
    {
      platform: "airbnb",
      name: "Ryan",
      country: "United States",
      text: "Beautiful spot, we were just there for the night but had everything we needed! Check-in was smooth and easy, would stay again!",
    },
    {
      platform: "airbnb",
      name: "David",
      country: "",
      text: "Ideal spot for our family trip. Eldor was really good and responded quickly to our communication. The recommendations given for a chef on Christmas Day and massages were excellent.",
    },
    {
      platform: "airbnb",
      name: "Viktor",
      country: "",
      text: "Eldor's place was stunning. Everything was like in the pictures and way better equipped than the usual villas I was staying in before.",
    },
  ],
  "tuxedo-1br": [
    {
      platform: "airbnb",
      name: "Jon",
      country: "Kuwait",
      text: "My stay was excellent, the view was breathtaking, every corner spotless, and the host was solid. Responded fast to everything, even pointed me to the best local spots.",
    },
    {
      platform: "airbnb",
      name: "Humza",
      country: "",
      text: "Eldor's villa had everything we wanted and more. He was attentive and responsive to all of our needs. If you are considering a place to stay in Koh Samui, this is the one.",
    },
    {
      platform: "airbnb",
      name: "Janette",
      country: "",
      text: "This home is very high quality built and in good condition. Everything was really clean. The scenery was stunning. Eldor and his family are wonderful and take care of everything perfectly.",
    },
  ],
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
