import type { Metadata } from "next";
import Image from "next/image";

export const metadata: Metadata = {
  title: "Motorbike & Car Rentals | Magic Suites & Villas",
  description: "Motorbikes and cars available directly through Magic Suites & Villas, Koh Samui.",
};

const vehicles = [
  {
    name: "Honda PCX 150 (White)",
    type: "Motorbike",
    price: "฿300 / day",
    image: "/images/rentals/pcx-150-white.jpg",
    description:
      "The 2016 PCX offers enough power and space to enjoy this bike through the island. Great for quick commuting and especially for beach days. Very easy to find parking, with some modifications to aid your needs.",
  },
  {
    name: "Honda Forza 350 (Blue and White)",
    type: "Motorbike",
    price: "฿800 / day",
    image: "/images/rentals/f3.jpg",
    description:
      "330cc motorcycle, great for touring around the island and for overall comfort with your partner. Offers a large seat with a large compartment, bottle and phone holders. If you ride safe, this bike is safer than lower engine sizes and has greater road capability.",
  },
  {
    name: "Honda PCX 160 (Grey)",
    type: "Motorbike",
    price: "฿400 / day",
    image: "/images/rentals/pcx-160-grey.jpg",
    description:
      "The 2023 PCX is a great moped to use around the island, with enough space for 2 helmets or two beach towels and a bag. Just the right power to not be intimidating, but able to stride up any hill. Added modifications include a frame slider, bottle holder and bag holder.",
  },
];

export default function RentalsPage() {
  return (
    <div className="mx-auto max-w-6xl px-5 py-16">
      <p className="text-sm uppercase tracking-[0.3em] text-pool">Get around the island</p>
      <h1 className="mt-3 font-serif text-4xl text-ink">Motorbike &amp; Car Rentals</h1>
      <p className="mt-4 max-w-2xl text-ink-soft">
        Motorbikes and cars available directly through us — no third party
        needed. Ask us at check-in or message us to reserve ahead of time.
      </p>

      <div className="mt-10 grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
        {vehicles.map((v) => (
          <div key={v.name} className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-black/5">
            <div className="relative aspect-[4/3] w-full">
              <Image src={v.image} alt={v.name} fill sizes="(min-width: 1024px) 33vw, 100vw" className="object-cover" />
            </div>
            <div className="p-5">
              <p className="text-xs uppercase tracking-wide text-pool">{v.type}</p>
              <h3 className="mt-1 font-serif text-lg text-ink">{v.name}</h3>
              <p className="mt-2 font-medium text-ink">Start from {v.price}</p>
              <p className="mt-3 text-sm leading-relaxed text-ink-soft">{v.description}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
