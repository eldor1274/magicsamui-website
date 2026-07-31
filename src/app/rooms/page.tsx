import type { Metadata } from "next";
import Image from "next/image";
import RoomCard from "@/components/RoomCard";
import { getRoomBySlug } from "@/data/rooms";
import { villas } from "@/data/villas";

export const metadata: Metadata = {
  title: "Suites & Villas | Magic Suites & Villas",
  description:
    "Explore Magic Villa's 4 private suites and the standalone Tuxedo Villa in Koh Samui — every suite has its own pool.",
};

const magicVilla = villas.find((v) => v.slug === "magic-villa")!;
const tuxedoVilla = villas.find((v) => v.slug === "tuxedo")!;
const combineSuites = [
  getRoomBySlug("seaview-2br")!,
  getRoomBySlug("island-view-3br")!,
  getRoomBySlug("tower-club-3br")!,
];

export default function RoomsPage() {
  return (
    <div className="mx-auto max-w-6xl px-5 py-16">
      <p className="text-sm uppercase tracking-[0.3em] text-pool">Magic Suites &amp; Villas</p>
      <h1 className="mt-3 font-serif text-4xl text-ink">2 Villas, 4 Suites</h1>
      <p className="mt-4 max-w-2xl text-ink-soft">
        Magic Villa is split into 4 individually bookable suites, each with
        its own pool. Tuxedo is a standalone villa with 1, 2 and 3 bedroom
        options. Every space is just minutes from Choeng Mon Beach.
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
          <div className="mt-5 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
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
    </div>
  );
}
