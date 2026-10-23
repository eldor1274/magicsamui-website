import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import EldorWaitlist from "@/components/EldorWaitlist";
import RoomCard from "@/components/RoomCard";
import { getRoomBySlug, rooms } from "@/data/rooms";
import { site } from "@/data/site";
import { villas } from "@/data/villas";
import { CATALOGUE, sharedUnits } from "@/lib/booking/catalogue";

/** The lowest reference rate on the site (the Garden Suite today), so the description can't go stale. */
const fromThb = Math.min(...rooms.map((r) => r.priceThb));

export const metadata: Metadata = {
  alternates: { canonical: "/rooms" },
  title: "Suites & Villas | Magic Suites & Villas",
  description: `Suites and villas in Koh Samui from ฿${fromThb.toLocaleString("en-US")} a night, most with a private pool: 3-bedroom stays for 6 and the whole villa, 5 bedrooms, sleeps 10.`,
};

const magicVilla = villas.find((v) => v.slug === "magic-villa")!;
const tuxedoVilla = villas.find((v) => v.slug === "tuxedo")!;
const combineSuites = [
  getRoomBySlug("seaview-2br")!,
  getRoomBySlug("island-view-3br")!,
  getRoomBySlug("tower-club-3br")!,
  getRoomBySlug("magic-1-villa")!,
];
const wholeMagicVilla = getRoomBySlug("magic-1-villa")!;

/** "Which stay fits your group?": every way to stay, smallest group first, straight from the booking catalogue. */
const bySize = [...CATALOGUE].sort(
  (a, b) => a.maxGuests - b.maxGuests || a.bedrooms - b.bedrooms || a.referencePriceThb - b.referencePriceThb
);
const threeBedroomsShareALevel = sharedUnits("tower-club-3br", "island-view-3br").length > 0;

export default function RoomsPage() {
  return (
    <div className="mx-auto max-w-6xl px-5 py-16">
      <p className="text-sm uppercase tracking-[0.3em] text-pool">Magic Suites &amp; Villas</p>
      <h1 className="mt-3 font-serif text-4xl text-ink">2 Villas, 5 Private Suites</h1>
      <p className="mt-4 max-w-2xl text-ink-soft">
        Magic Villa is split into 4 individually bookable suites; all but the
        Garden Suite have their own pool. Tuxedo is a standalone villa with 1,
        2 and 3 bedroom options, plus the Seaview Unit, a private suite on its
        lower level. Every space is just minutes from Choeng Mon Beach — and two
        brand-new villas, EL and DOR, are opening soon.
      </p>

      <section className="mt-14">
        <div className="grid gap-8 lg:grid-cols-3 lg:items-center">
          <div className="relative aspect-[4/3] overflow-hidden rounded-2xl lg:col-span-1">
            <Image
              src={magicVilla.heroImage.src}
              alt={magicVilla.heroImage.alt}
              fill
              // First photo on the page = the LCP element on phones; Lighthouse
              // (2026-09-09) caught it lazy-loading, adding ~1.6s of load delay.
              preload
              fetchPriority="high"
              quality={60}
              sizes="(min-width: 1024px) 33vw, 100vw"
              className="object-cover"
            />
          </div>
          <div className="lg:col-span-2">
            <h2 className="font-serif text-2xl text-ink">{magicVilla.name}</h2>
            <p className="mt-3 text-ink-soft leading-relaxed">{magicVilla.description}</p>
          </div>
        </div>
        <div className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {magicVilla.roomSlugs.map((slug) => {
            const room = getRoomBySlug(slug)!;
            return <RoomCard key={room.slug} room={room} />;
          })}
        </div>

        <div className="mt-8 rounded-2xl bg-stone-100 p-6">
          <p className="font-medium text-ink">Travelling as a bigger group?</p>
          <p className="mt-1 text-sm text-ink-soft">
            Combine adjoining suites in Magic Villa for a 2 or 3 bedroom stay, or
            take the entire villa: {wholeMagicVilla.bedrooms} bedrooms for up to{" "}
            {wholeMagicVilla.guests} guests.
          </p>
          <div className="mt-5 grid gap-6 sm:grid-cols-2">
            {combineSuites.map((room) => (
              <RoomCard key={room.slug} room={room} />
            ))}
          </div>
        </div>
      </section>

      <section className="mt-16">
        <div className="grid gap-8 lg:grid-cols-3 lg:items-center">
          <div className="relative aspect-[4/3] overflow-hidden rounded-2xl lg:col-span-1">
            <Image
              src={tuxedoVilla.heroImage.src}
              alt={tuxedoVilla.heroImage.alt}
              fill
              sizes="(min-width: 1024px) 33vw, 100vw"
              className="object-cover"
            />
          </div>
          <div className="lg:col-span-2">
            <h2 className="font-serif text-2xl text-ink">{tuxedoVilla.name}</h2>
            <p className="mt-3 text-ink-soft leading-relaxed">{tuxedoVilla.description}</p>
          </div>
        </div>
        <div className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {tuxedoVilla.roomSlugs.map((slug) => {
            const room = getRoomBySlug(slug)!;
            return <RoomCard key={room.slug} room={room} />;
          })}
        </div>
      </section>

      <section id="group-sizes" className="mt-16">
        <h2 className="font-serif text-2xl text-ink">Which stay fits your group?</h2>
        <p className="mt-2 max-w-2xl text-sm text-ink-soft">
          Every way to stay, from couples to groups of {bySize[bySize.length - 1].maxGuests}. Stays marked
          on request are booked on WhatsApp; all others book online. Prices are reference rates
          per night; the booking page shows live prices for your dates.
        </p>
        <div className="mt-6 overflow-x-auto rounded-2xl ring-1 ring-black/5">
          <table className="w-full text-left text-xs sm:text-sm">
            <thead className="bg-stone-100 text-ink">
              <tr>
                <th scope="col" className="px-2 py-3 font-medium sm:px-4">Stay</th>
                <th scope="col" className="px-1.5 py-3 font-medium sm:px-4">Guests</th>
                <th scope="col" className="px-1.5 py-3 font-medium sm:px-4">Bed&shy;rooms</th>
                <th scope="col" className="px-1.5 py-3 font-medium sm:px-4">Private pool</th>
                <th scope="col" className="px-1.5 py-3 font-medium sm:px-4">
                  From<span className="hidden sm:inline"> / night</span>
                </th>
                <th scope="col" className="hidden px-2 py-3 font-medium sm:table-cell sm:px-4">Book</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100 bg-white text-ink-soft">
              {bySize.map((room) => (
                <tr key={room.slug}>
                  <th scope="row" className="px-2 py-3 font-normal sm:px-4">
                    <Link href={`/rooms/${room.slug}`} className="text-pool hover:underline">
                      {room.shortName}
                    </Link>
                    {!room.bookable && <span className="block text-ink-soft sm:hidden">On request</span>}
                  </th>
                  <td className="px-1.5 py-3 sm:px-4">{room.maxGuests}</td>
                  <td className="px-1.5 py-3 sm:px-4">{room.bedrooms}</td>
                  <td className="px-1.5 py-3 sm:px-4">{room.hasPool ? "Yes" : "No"}</td>
                  <td className="whitespace-nowrap px-1.5 py-3 sm:px-4">
                    ฿{room.referencePriceThb.toLocaleString("en-US")}
                  </td>
                  <td className="hidden px-2 py-3 sm:table-cell sm:px-4">
                    {room.bookable ? (
                      <Link href="/booking" className="text-pool hover:underline">
                        Online
                      </Link>
                    ) : (
                      <a href={site.whatsapp} className="text-pool hover:underline">
                        On request
                      </a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {threeBedroomsShareALevel && (
          <p className="mt-3 text-xs text-ink-soft">
            Tower Club and Island View share the Magic Seaview level, so one of the two can be
            booked on a given night. The entire Magic Villa includes all four Magic Villa suites.
          </p>
        )}
      </section>

      <section className="mt-16 overflow-hidden rounded-3xl bg-ink text-stone-50">
        <div className="relative">
          <Image
            src="/images/eldor-villa/aerial.jpg"
            alt="Villa EL and Villa DOR taking shape on the hillside below Magic Villa"
            fill
            quality={60}
            sizes="100vw"
            className="object-cover"
          />
          <div className="absolute inset-0 bg-gradient-to-r from-ink/95 via-ink/75 to-ink/30" />
          <div className="relative max-w-2xl p-8 lg:p-12">
            <span className="inline-block rounded-full bg-sand px-4 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-ink">
              Coming soon
            </span>
            <h2 className="mt-4 font-serif text-3xl">ELDOR Villa</h2>
            <p className="mt-4 leading-relaxed text-stone-50/80">
              Just below Magic Villa and Tuxedo, two new villas are taking
              their final shape: <span className="font-medium text-stone-50">Villa EL</span> and{" "}
              <span className="font-medium text-stone-50">Villa DOR</span>. Put the names together
              and you get ELDOR — our host, who has built and watched over
              this hillside from the very first stone.
            </p>
            <p className="mt-4 leading-relaxed text-stone-50/80">
              Carved into the rock of the same serene hillside, in the quiet
              residence overlooking the gulf of Thailand, the villas carry
              the signature of everything around them — ultra-modern lines
              softened by natural stone rising from the mountain, and living
              grass roofs that melt into the green of Koh Samui. Designed to
              feel like they grew here, not like they were built here.
            </p>
            <p className="mt-4 leading-relaxed text-stone-50/80">
              Each villa sleeps four across 2 bedrooms with 3 bathrooms and 3
              showers, with everything you love about the Honeymoon Suite —
              plus your own washing and drying machine for longer stays.
            </p>
            <div className="mt-6 flex flex-wrap gap-2 text-sm">
              {["2 bedrooms", "3 bathrooms", "Sleeps 4", "Washer & dryer"].map((chip) => (
                <span key={chip} className="rounded-full border border-stone-50/30 px-4 py-1.5 text-stone-50/90">
                  {chip}
                </span>
              ))}
            </div>
            <EldorWaitlist />
          </div>
        </div>
        <div className="grid gap-0 sm:grid-cols-2">
          <div className="relative aspect-[16/9]">
            <Image
              src="/images/eldor-villa/el-terrace.jpg"
              alt="Villa EL top floor with rooftop lawn terrace"
              fill
              quality={60}
              sizes="(min-width: 640px) 50vw, 100vw"
              className="object-cover"
            />
          </div>
          <div className="relative aspect-[16/9]">
            <Image
              src="/images/eldor-villa/el-night.jpg"
              alt="Villa EL glowing at night"
              fill
              quality={60}
              sizes="(min-width: 640px) 50vw, 100vw"
              className="object-cover"
            />
          </div>
        </div>
      </section>
    </div>
  );
}
