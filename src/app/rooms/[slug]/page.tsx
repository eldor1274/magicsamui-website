import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { BedDouble, Users, Bath, Ruler, Star, Check } from "lucide-react";
import BookNowButton from "@/components/BookNowButton";
import RoomGallery from "@/components/RoomGallery";
import { rooms, getRoomBySlug } from "@/data/rooms";

export function generateStaticParams() {
  return rooms.map((room) => ({ slug: room.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const room = getRoomBySlug(slug);
  if (!room) return {};
  return {
    title: `${room.name} | Magic Suites & Villas`,
    description: room.summary,
  };
}

export default async function RoomPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const room = getRoomBySlug(slug);
  if (!room) notFound();

  const otherRooms = rooms.filter((r) => r.slug !== room.slug);

  return (
    <div className="mx-auto max-w-6xl px-5 py-12">
      <div className="grid gap-10 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <RoomGallery images={room.gallery} />
        </div>

        <div>
          <h1 className="font-serif text-3xl text-ink">{room.name}</h1>
          <div className="mt-2 flex items-center gap-1 text-sand">
            {Array.from({ length: 5 }).map((_, i) => (
              <Star key={i} size={16} fill="currentColor" strokeWidth={0} />
            ))}
            <span className="ml-1 text-sm text-ink-soft">Rated 5 out of 5</span>
          </div>

          <p className="mt-5 font-serif text-3xl text-pool">
            ฿{room.priceThb.toLocaleString()}
            <span className="text-base text-ink-soft"> / night (reference price)</span>
          </p>

          <div className="mt-6 grid grid-cols-2 gap-4 rounded-xl bg-stone-100 p-4 text-sm text-ink-soft">
            <span className="flex items-center gap-2">
              <Ruler size={16} /> {room.area.sqm} m² / {room.area.sqft} sq ft
            </span>
            <span className="flex items-center gap-2">
              <BedDouble size={16} /> {room.bedrooms} bedroom{room.bedrooms > 1 ? "s" : ""}
            </span>
            <span className="flex items-center gap-2">
              <Users size={16} /> {room.guests} guests
            </span>
            <span className="flex items-center gap-2">
              <Bath size={16} /> {room.bathrooms} bathroom{room.bathrooms > 1 ? "s" : ""}
            </span>
          </div>

          <BookNowButton className="mt-6 w-full" />
        </div>
      </div>

      <div className="mt-14 grid gap-14 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <h2 className="font-serif text-2xl text-ink">Overview</h2>
          {room.description.map((p, i) => (
            <p key={i} className="leading-relaxed text-ink-soft">
              {p}
            </p>
          ))}

          <h2 className="pt-6 font-serif text-2xl text-ink">Amenities</h2>
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">
            {room.amenities.map((a) => (
              <span key={a} className="flex items-center gap-2 text-sm text-ink-soft">
                <Check size={14} className="shrink-0 text-pool" /> {a}
              </span>
            ))}
          </div>

          {room.guestAccess && (
            <>
              <h2 className="pt-6 font-serif text-2xl text-ink">Guest Access</h2>
              <ul className="list-disc space-y-1 pl-5 text-ink-soft">
                {room.guestAccess.map((g, i) => (
                  <li key={i}>{g}</li>
                ))}
              </ul>
            </>
          )}

          {room.notes && (
            <>
              <h2 className="pt-6 font-serif text-2xl text-ink">Good to Know</h2>
              <ul className="list-disc space-y-1 pl-5 text-ink-soft">
                {room.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </>
          )}
        </div>

        <div>
          <h2 className="font-serif text-2xl text-ink">Important Info</h2>
          <dl className="mt-4 space-y-3 rounded-xl bg-stone-100 p-5 text-sm">
            {[
              ["Check-in", room.importantInfo.checkIn],
              ["Check-out", room.importantInfo.checkOut],
              ["Pets", room.importantInfo.pets],
              ["Children", room.importantInfo.children],
              ["Smoking", room.importantInfo.smoking],
              ["Party", room.importantInfo.party],
            ].map(([label, value]) => (
              <div key={label} className="flex justify-between border-b border-stone-100 pb-2 last:border-0">
                <dt className="text-ink-soft">{label}</dt>
                <dd className="font-medium text-ink">{value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>

      <div className="mt-16">
        <h2 className="font-serif text-2xl text-ink">Explore Other Suites</h2>
        <div className="mt-6 flex flex-wrap gap-3">
          {otherRooms.map((r) => (
            <Link
              key={r.slug}
              href={`/rooms/${r.slug}`}
              className="rounded-full border border-stone-100 bg-white px-4 py-2 text-sm text-ink-soft transition-colors hover:border-pool hover:text-pool"
            >
              {r.shortName}
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
