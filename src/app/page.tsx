import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import {
  Wifi,
  WashingMachine,
  Bike,
  Car,
  ArrowRight,
  BadgePercent,
  PlaneLanding,
  MessageCircle,
  Clock,
} from "lucide-react";
import JsonLd from "@/components/JsonLd";
import { resortJsonLd } from "@/lib/structuredData";
import BookNowButton from "@/components/BookNowButton";
import CloudbedsDatePicker from "@/components/CloudbedsDatePicker";
import DesktopVideo from "@/components/DesktopVideo";
import ReviewsSection from "@/components/ReviewsSection";
import RoomCard from "@/components/RoomCard";
import { rooms } from "@/data/rooms";
import { getAllBlogPosts } from "@/data/blog";

const featuredRooms = rooms.filter(
  (r) =>
    ![
      "seaview-2br",
      "island-view-3br",
      "tower-club-3br",
      "magic-1-villa",
      "tuxedo-1br",
      "tuxedo-3br",
    ].includes(r.slug)
);

const directPerks = [
  {
    icon: BadgePercent,
    title: "Best rate, always",
    text: "Code DIRECT at checkout beats any booking site.",
  },
  {
    icon: PlaneLanding,
    title: "Free airport pickup",
    text: "Complimentary transfer on stays of 2+ nights.",
  },
  {
    icon: MessageCircle,
    title: "Direct line to the host",
    text: "WhatsApp with us before, during and after your stay.",
  },
  {
    icon: Clock,
    title: "Flexible arrival",
    text: "Drop your luggage anytime — just let us know ahead.",
  },
];

const essentials = [
  { icon: Wifi, label: "Free Wi-Fi" },
  { icon: WashingMachine, label: "Laundry Service" },
  { icon: Bike, label: "Motorbike / Car Rental" },
  { icon: Car, label: "Transportation Service" },
];

export const metadata: Metadata = {
  alternates: { canonical: "/" },
};

export default function Home() {
  const latestPosts = getAllBlogPosts().slice(0, 3);

  return (
    <>
      <JsonLd data={resortJsonLd()} />
      <section className="relative flex h-[90vh] min-h-[560px] w-full items-end">
        <Image
          src="/images/home/Magic-Suites-50-2.jpg"
          alt="Magic Suites private pool villa at sunset"
          fill
          preload
          fetchPriority="high"
          quality={60}
          sizes="100vw"
          className="object-cover"
        />
        <DesktopVideo
          src="/videos/hero-tuxedo.mp4"
          className="absolute inset-0 h-full w-full object-cover"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-white/85 via-white/45 to-white/10 sm:from-black/70 sm:via-black/20 sm:to-black/10" />
        <div className="relative mx-auto w-full max-w-6xl px-5 pb-16 text-ink sm:text-stone-50">
          <p className="text-base font-semibold uppercase tracking-[0.3em] text-ink sm:text-stone-100/90">
            Koh Samui, Thailand
          </p>
          <h1 className="mt-4 max-w-xl font-serif text-4xl leading-tight sm:text-5xl">
            Magic Private Pool Villas
          </h1>
          <p className="mt-4 max-w-lg text-ink-soft sm:text-stone-100/90">
            2 villas, 4 private suites — each with its own pool, on a hillside
            overlooking the gulf of Thailand, just 5 minutes from the beach.
          </p>
          <div className="mt-8 flex flex-wrap gap-4">
            <BookNowButton />
            <Link
              href="/rooms"
              className="inline-flex items-center gap-2 rounded-full border border-ink/30 px-6 py-3 text-sm font-medium text-ink transition-colors hover:bg-black/5 sm:border-stone-100/60 sm:text-stone-50 sm:hover:bg-white/10"
            >
              View Suites &amp; Villas <ArrowRight size={16} />
            </Link>
          </div>
        </div>
      </section>

      <section className="mx-auto -mt-9 max-w-3xl px-5">
        <CloudbedsDatePicker />
      </section>

      <section className="mx-auto max-w-6xl px-5 pt-12">
        <p className="text-center text-sm uppercase tracking-[0.3em] text-pool">
          Why book direct
        </p>
        <div className="mt-6 grid grid-cols-2 gap-5 lg:grid-cols-4">
          {directPerks.map(({ icon: Icon, title, text }) => (
            <div key={title} className="rounded-2xl bg-stone-100 p-5">
              <Icon size={22} className="text-pool" />
              <p className="mt-3 text-sm font-semibold text-ink">{title}</p>
              <p className="mt-1 text-sm leading-relaxed text-ink-soft">{text}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto grid max-w-6xl grid-cols-2 gap-6 px-5 py-14 text-center sm:grid-cols-4">
        {[
          ["2", "Villas, 1 location"],
          ["4", "Suites in Magic Villa"],
          ["2 min", "To groceries by motorbike"],
          ["5 min", "To the beach"],
        ].map(([stat, label]) => (
          <div key={label}>
            <p className="font-serif text-3xl text-pool">{stat}</p>
            <p className="mt-1 text-sm text-ink-soft">{label}</p>
          </div>
        ))}
      </section>

      <section className="mx-auto grid max-w-6xl gap-10 px-5 py-14 lg:grid-cols-2 lg:items-center">
        <div className="relative aspect-[4/3] overflow-hidden rounded-2xl">
          <Image
            src="/images/home/DMZ_3612-2.jpg"
            alt="Rooftop garden and pool terrace"
            fill
            quality={60}
            sizes="(min-width: 1024px) 50vw, 100vw"
            className="object-cover"
          />
        </div>
        <div>
          <p className="text-sm uppercase tracking-[0.3em] text-pool">Est. in Koh Samui</p>
          <h2 className="mt-3 font-serif text-3xl text-ink">The Magic Behind The Villa</h2>
          <p className="mt-5 text-ink-soft leading-relaxed">
            Nestled in the serene beauty of Koh Samui, the ultra-modern private
            pool villas effortlessly weave their charm into the lush natural
            landscape. Constructed with the vision to seamlessly blend with
            its surroundings, natural stone emerging gracefully from the
            mountain adds robustness and a sense of regality to the structure.
          </p>
          <p className="mt-4 text-ink-soft leading-relaxed">
            Indulge in Thailand&apos;s magical sea view villas, where luxury and
            nature coalesce to create an unforgettable experience — a retreat
            like no other, surrounded by the majestic beauty of Koh Samui.
          </p>
        </div>
      </section>

      <section className="bg-stone-100 py-14">
        <div className="mx-auto max-w-6xl px-5">
          <h2 className="text-center font-serif text-2xl text-ink">The Essentials</h2>
          <div className="mt-8 grid grid-cols-2 gap-6 sm:grid-cols-4">
            {essentials.map(({ icon: Icon, label }) => (
              <div key={label} className="flex flex-col items-center gap-3 text-center">
                <span className="flex h-14 w-14 items-center justify-center rounded-full bg-white text-pool ring-1 ring-black/5">
                  <Icon size={22} />
                </span>
                <p className="text-sm text-ink-soft">{label}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-5 py-16">
        <div className="flex items-end justify-between">
          <h2 className="font-serif text-3xl text-ink">Suite Residences</h2>
          <Link href="/rooms" className="hidden items-center gap-2 text-sm text-pool sm:flex">
            View all <ArrowRight size={16} />
          </Link>
        </div>
        <div className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {featuredRooms.map((room) => (
            <RoomCard key={room.slug} room={room} />
          ))}
        </div>
        <div className="mt-8 flex justify-center sm:hidden">
          <Link href="/rooms" className="flex items-center gap-2 text-sm text-pool">
            View all <ArrowRight size={16} />
          </Link>
        </div>
      </section>

      <ReviewsSection />

      <section className="mx-auto max-w-6xl px-5 py-16">
        <div className="flex items-end justify-between">
          <h2 className="font-serif text-3xl text-ink">From the Blog</h2>
          <Link href="/blog" className="hidden items-center gap-2 text-sm text-pool sm:flex">
            View all <ArrowRight size={16} />
          </Link>
        </div>
        <div className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {latestPosts.map((post) => (
            <Link
              key={post.slug}
              href={`/blog/${post.slug}`}
              className="group flex flex-col overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-black/5 transition-shadow hover:shadow-lg"
            >
              {post.heroImage && (
                <div className="relative aspect-[4/3] w-full overflow-hidden">
                  <Image
                    src={post.heroImage}
                    alt={post.title}
                    fill
                    sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw"
                    className="object-cover transition-transform duration-500 group-hover:scale-105"
                  />
                </div>
              )}
              <div className="flex flex-1 flex-col gap-2 p-5">
                <h3 className="font-serif text-lg leading-snug text-ink">{post.title}</h3>
                <p className="text-sm text-ink-soft line-clamp-3">{post.description}</p>
              </div>
            </Link>
          ))}
        </div>
      </section>

      <section className="relative flex min-h-[320px] items-center justify-center overflow-hidden">
        <Image
          src="/images/tuxedo/DMZ_3612-1.jpg"
          alt="Private pool villa at dusk"
          fill
          quality={60}
          sizes="100vw"
          className="object-cover"
        />
        <div className="absolute inset-0 bg-black/60" />
        <div className="relative px-5 text-center text-stone-50">
          <h2 className="font-serif text-2xl sm:text-3xl">
            Ready for your Koh Samui escape?
          </h2>
          <div className="mt-6 flex justify-center">
            <BookNowButton />
          </div>
        </div>
      </section>
    </>
  );
}
