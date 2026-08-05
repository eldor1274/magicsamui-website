import type { Metadata } from "next";
import Image from "next/image";
import EldorWaitlist from "@/components/EldorWaitlist";
import RoomCard from "@/components/RoomCard";
import { getRoomBySlug } from "@/data/rooms";
import { villas } from "@/data/villas";

export const metadata: Metadata = {
  alternates: { canonical: "/rooms" },
  title: "Suites & Villas | Magic Suites & Villas",
  description:
    "Luxury private pool suites and villas in Koh Samui from ฿4,000 a night — Magic Villa's 4 private suites and the standalone Tuxedo Villa, every one with its own pool.",
};

const magicVilla = villas.find((v) => v.slug === "magic-villa")!;
const tuxedoVilla = villas.find((v) => v.slug === "tuxedo")!;
const combineSuites = [
  getRoomBySlug("seaview-2br")!,
  getRoomBySlug("island-view-3br")!,
  getRoomBySlug("tower-club-3br")!,
  getRoomBySlug("magic-1-villa")!,
];

export default function RoomsPage() {
  return (
    <div className="mx-auto max-w-6xl px-5 py-16">
      <p className="text-sm uppercase tracking-[0.3em] text-pool">Magic Suites &amp; Villas</p>
      <h1 className="mt-3 font-serif text-4xl text-ink">2 Villas, 4 Suites</h1>
      <p className="mt-4 max-w-2xl text-ink-soft">
        Magic Villa is split into 4 individually bookable suites, each with
        its own pool. Tuxedo is a standalone villa with 1, 2 and 3 bedroom
        options. Every space is just minutes from Choeng Mon Beach — and two
        brand-new villas, EL and DOR, are opening soon.
      </p>

      <section className="mt-14">
        <div className="grid gap-8 lg:grid-cols-3 lg:items-center">
          <div className="relative aspect-[4/3] overflow-hidden rounded-2xl lg:col-span-1">
            <Image
              src={magicVilla.heroImage.src}
              alt={magicVilla.heroImage.alt}
              fill
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
            Combine adjoining suites in Magic Villa for a 2 or 3 bedroom stay.
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
