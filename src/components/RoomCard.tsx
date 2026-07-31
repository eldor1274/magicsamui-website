import Image from "next/image";
import Link from "next/link";
import { BedDouble, Users, Ruler } from "lucide-react";
import DesktopVideo from "@/components/DesktopVideo";
import LiveTonight from "@/components/LiveTonight";
import type { Room } from "@/data/rooms";

export default function RoomCard({ room }: { room: Room }) {
  return (
    <Link
      href={`/rooms/${room.slug}`}
      className="group flex flex-col overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-black/5 transition-shadow hover:shadow-lg"
    >
      <div className="relative aspect-[4/3] w-full overflow-hidden">
        <Image
          src={room.heroImage.src}
          alt={room.heroImage.alt}
          fill
          sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw"
          className="object-cover transition-transform duration-500 group-hover:scale-105"
        />
        {room.cardVideo && (
          <DesktopVideo
            src={room.cardVideo}
            className="absolute inset-0 h-full w-full object-cover"
          />
        )}
        {room.hasPool === false ? (
          <span className="absolute left-3 top-3 rounded-full bg-sand px-3 py-1 text-xs font-medium text-ink shadow">
            No private pool
          </span>
        ) : (
          room.poolType && (
            <span className="absolute left-3 top-3 rounded-full bg-white/90 px-3 py-1 text-xs font-medium text-pool shadow backdrop-blur-sm">
              {room.poolType}
            </span>
          )
        )}
      </div>
      <div className="flex flex-1 flex-col gap-3 p-5">
        <h3 className="font-serif text-lg text-ink">{room.shortName}</h3>
        <p className="text-sm text-ink-soft line-clamp-2">{room.summary}</p>
        <div className="mt-auto flex items-center gap-4 pt-2 text-xs text-ink-soft">
          <span className="flex items-center gap-1">
            <Ruler size={14} /> {room.area.sqm} m²
          </span>
          <span className="flex items-center gap-1">
            <BedDouble size={14} /> {room.bedrooms}
          </span>
          <span className="flex items-center gap-1">
            <Users size={14} /> {room.guests}
          </span>
        </div>
        <div className="flex items-center justify-between border-t border-stone-100 pt-3">
          <span className="text-sm text-ink-soft">From</span>
          <span className="font-serif text-lg text-pool">
            ฿{room.priceThb.toLocaleString()}
            <span className="text-xs text-ink-soft"> / night</span>
          </span>
        </div>
        <LiveTonight slug={room.slug} />
      </div>
    </Link>
  );
}
