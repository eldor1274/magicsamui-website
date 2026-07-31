import type { Metadata } from "next";
import RoomCard from "@/components/RoomCard";
import { rooms } from "@/data/rooms";

export const metadata: Metadata = {
  title: "Suites & Villas | Magic Suites & Villas",
  description:
    "Explore our private pool suites and villas in Koh Samui, from cozy garden view suites to a 3 bedroom island view villa.",
};

export default function RoomsPage() {
  return (
    <div className="mx-auto max-w-6xl px-5 py-16">
      <p className="text-sm uppercase tracking-[0.3em] text-pool">Magic Suites &amp; Villas</p>
      <h1 className="mt-3 font-serif text-4xl text-ink">Suites &amp; Villas</h1>
      <p className="mt-4 max-w-2xl text-ink-soft">
        Five private units, sold in seven different ways — from an intimate
        garden view suite to a full 3 bedroom island view villa. Every suite
        has its own pool.
      </p>
      <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {rooms.map((room) => (
          <RoomCard key={room.slug} room={room} />
        ))}
      </div>
    </div>
  );
}
