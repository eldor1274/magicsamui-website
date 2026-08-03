import type { Metadata } from "next";
import Link from "next/link";
import {
  MapPin,
  MessageCircle,
  ShoppingBasket,
  Fuel,
  Shirt,
  Sparkles,
  ShieldAlert,
  Coffee,
  UtensilsCrossed,
  Waves,
  Landmark,
  Star,
  ExternalLink,
  Ship,
} from "lucide-react";
import { site } from "@/data/site";
import TravelBookingWidget from "@/components/TravelBookingWidget";
import {
  breakfastSpots,
  lunchDinnerSpots,
  beaches,
  templesAndSights,
  guideLists,
  mapsSearchUrl,
  twelveGoRouteUrl,
  type GuidePlace,
} from "@/data/guidePlaces";

function RouteLink({ from, to, label }: { from: string; to: string; label: string }) {
  return (
    <a
      href={twelveGoRouteUrl(from, to)}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1.5 rounded-full border border-pool px-4 py-2 text-sm font-medium text-pool transition-colors hover:bg-pool hover:text-white"
    >
      {label} <ExternalLink size={13} />
    </a>
  );
}

function PlaceCard({ place }: { place: GuidePlace }) {
  return (
    <a
      href={mapsSearchUrl(place.name)}
      target="_blank"
      rel="noopener noreferrer"
      className="rounded-xl bg-stone-100 p-4 transition-colors hover:bg-stone-100/60"
    >
      <p className="font-medium text-ink">{place.name}</p>
      <p className="mt-1 flex items-center gap-1 text-sm text-ink-soft">
        <Star size={13} className="text-sand" fill="currentColor" strokeWidth={0} />
        {place.rating} ({place.reviews.toLocaleString()}) · {place.type}
        {place.price ? ` · ${place.price}` : ""}
      </p>
      <p className="mt-1 text-sm font-medium text-pool">
        {place.distanceKm} km · ~{place.driveMin} min by motorbike
      </p>
    </a>
  );
}

function ListLink({ href }: { href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="mt-4 inline-flex items-center gap-1.5 text-sm text-pool underline"
    >
      Open the full list in Google Maps <ExternalLink size={13} />
    </a>
  );
}

export const metadata: Metadata = {
  alternates: { canonical: "/guide" },
  title: "Island Guide | Magic Suites & Villas",
  description: "Everything you need during your stay at Magic Suites & Villas, Koh Samui.",
};

export default function GuidePage() {
  return (
    <div className="mx-auto max-w-4xl px-5 py-16">
      <p className="text-sm uppercase tracking-[0.3em] text-pool">Your island guide</p>
      <h1 className="mt-3 font-serif text-4xl text-ink">Everything You Need During Your Stay</h1>

      <section className="mt-12">
        <h2 className="flex items-center gap-2 font-serif text-2xl text-ink">
          <MapPin size={20} className="text-pool" /> Getting Around
        </h2>
        <div className="mt-4 space-y-4 text-ink-soft">
          <p>
            Our location: Bo Put Moo 5, 51/140, Ko Samui District, Surat Thani —{" "}
            <a href={site.mapsUrl} className="text-pool underline">
              open in Maps
            </a>
            .
          </p>
          <p>
            <span className="font-medium text-ink">WhatsApp taxis:</span>{" "}
            +66 81 270 5628 (regular). Our drivers know the area well and have
            never had an issue getting you from A to B — please inquire
            directly with the driver for pricing.
          </p>
          <p>
            <span className="font-medium text-ink">Rentals:</span> Motorbikes
            and cars available directly through us. PCX 150, PCX 160, Forza
            350 and more —{" "}
            <Link href="/rentals" className="text-pool underline">
              view all rentals
            </Link>
            .
          </p>
          <p>
            <span className="font-medium text-ink">
              Ferries, trains, buses &amp; flights:
            </span>{" "}
            book onward travel anywhere in Thailand and Asia — Koh Phangan,
            Koh Tao, Bangkok, Chiang Mai and beyond. Search below and pay
            online; tickets arrive by email.
          </p>
          <TravelBookingWidget />
        </div>
      </section>

      <section className="mt-12">
        <h2 className="flex items-center gap-2 font-serif text-2xl text-ink">
          <Ship size={20} className="text-pool" /> Island Hopping: Koh Phangan &amp; Koh Tao
        </h2>
        <p className="mt-2 text-ink-soft">
          The two most asked-about trips. Live timetables and prices are one
          tap away — book online, tickets arrive by email.
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="rounded-xl bg-stone-100 p-5">
            <p className="font-medium text-ink">Koh Phangan</p>
            <p className="mt-1 text-sm text-ink-soft">
              20–50 min by ferry · from ~฿220 · boats all day from early
              morning to evening. Lomprayah and Seatran leave from Bangrak
              pier, a few minutes&apos; drive from the villas; Songserm from
              Nathon. All arrive at Thong Sala pier.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <RouteLink from="koh-samui" to="koh-phangan" label="Samui → Koh Phangan" />
              <RouteLink from="koh-phangan" to="koh-samui" label="Koh Phangan → Samui" />
            </div>
          </div>
          <div className="rounded-xl bg-stone-100 p-5">
            <p className="font-medium text-ink">Koh Tao</p>
            <p className="mt-1 text-sm text-ink-soft">
              1.5–3 h by ferry · from ~฿490 · first boats around 08:00, most
              via Koh Phangan. Lomprayah, Boonsiri, Seatran and Songserm all
              serve the route; arrival is at Mae Haad pier.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <RouteLink from="koh-samui" to="koh-tao" label="Samui → Koh Tao" />
              <RouteLink from="koh-tao" to="koh-samui" label="Koh Tao → Samui" />
            </div>
          </div>
        </div>
      </section>

      <section className="mt-12">
        <h2 className="flex items-center gap-2 font-serif text-2xl text-ink">
          <ShoppingBasket size={20} className="text-pool" /> Nearby Essentials
        </h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="rounded-xl bg-stone-100 p-4">
            <p className="flex items-center gap-2 font-medium text-ink">
              <Fuel size={16} /> Nearest gas station
            </p>
            <p className="mt-1 text-sm text-ink-soft">
              Caltex — right next to the property. May not be updated on Maps yet.
            </p>
          </div>
          <div className="rounded-xl bg-stone-100 p-4">
            <p className="font-medium text-ink">Nearby groceries</p>
            <p className="mt-1 text-sm text-ink-soft">
              Tesco · Mini Big C · 7-Eleven (24h). A local vegetable vendor
              (~10h/day) also has fresh vegetables, dairy &amp; meat within reach.
            </p>
          </div>
          <div className="rounded-xl bg-stone-100 p-4">
            <p className="font-medium text-ink">Bar Mr. Don</p>
            <p className="mt-1 text-sm text-ink-soft">
              Closest bar &amp; food delivery. Mention Magic Suites when ordering.
            </p>
          </div>
          <div className="rounded-xl bg-stone-100 p-4">
            <p className="font-medium text-ink">Currency exchange</p>
            <p className="mt-1 text-sm text-ink-soft">
              Ko Samui Exchange — competitive rates nearby.
            </p>
          </div>
        </div>
      </section>

      <section className="mt-12">
        <h2 className="flex items-center gap-2 font-serif text-2xl text-ink">
          <Coffee size={20} className="text-pool" /> Breakfast Spots
        </h2>
        <p className="mt-2 text-ink-soft">Our favourite places to start the day.</p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {breakfastSpots.map((place) => (
            <PlaceCard key={place.name} place={place} />
          ))}
        </div>
        <ListLink href={guideLists.breakfast} />
      </section>

      <section className="mt-12">
        <h2 className="flex items-center gap-2 font-serif text-2xl text-ink">
          <UtensilsCrossed size={20} className="text-pool" /> Lunch &amp; Dinner
        </h2>
        <p className="mt-2 text-ink-soft">
          Places to have lunch and dinner in Choeng Mon, minutes from the villas.
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {lunchDinnerSpots.map((place) => (
            <PlaceCard key={place.name} place={place} />
          ))}
        </div>
        <ListLink href={guideLists.lunchDinner} />
      </section>

      <section className="mt-12">
        <h2 className="flex items-center gap-2 font-serif text-2xl text-ink">
          <Waves size={20} className="text-pool" /> Swimmable Beaches
        </h2>
        <p className="mt-2 text-ink-soft">
          The beaches around the island we recommend for swimming.
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {beaches.map((place) => (
            <PlaceCard key={place.name} place={place} />
          ))}
        </div>

        <h2 className="mt-10 flex items-center gap-2 font-serif text-2xl text-ink">
          <Landmark size={20} className="text-pool" /> Temples &amp; Sights
        </h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {templesAndSights.map((place) => (
            <PlaceCard key={place.name} place={place} />
          ))}
        </div>
        <ListLink href={guideLists.beachesTemples} />
      </section>

      <section className="mt-12">
        <h2 className="flex items-center gap-2 font-serif text-2xl text-ink">
          <Sparkles size={20} className="text-pool" /> Our Services
        </h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="rounded-xl bg-stone-100 p-4">
            <p className="flex items-center gap-2 font-medium text-ink">
              <Shirt size={16} /> Laundry service
            </p>
            <p className="mt-1 text-sm text-ink-soft">
              Delivery to your door. Mention Magic Suites &amp; your room name.
              +66 95 296 3879 (WhatsApp)
            </p>
          </div>
          <div className="rounded-xl bg-stone-100 p-4">
            <p className="font-medium text-ink">Home spa</p>
            <p className="mt-1 text-sm text-ink-soft">
              Book with Natty. Mention Magic Suites &amp; room name. +66 81 454
              1523 (WhatsApp Natty)
            </p>
          </div>
        </div>
      </section>

      <section className="mt-12">
        <h2 className="flex items-center gap-2 font-serif text-2xl text-ink">
          <ShieldAlert size={20} className="text-pool" /> Emergency Contacts
        </h2>
        <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
          {[
            ["Our team, 24/7", "+66 95 246 6011"],
            ["Our team, 24/7", "+66 91 860 5001"],
            ["Police", "191"],
            ["Ambulance", "1669"],
            ["Fire", "199"],
            ["Tourist Police", "1155"],
          ].map(([label, number]) => (
            <div key={label + number} className="rounded-xl bg-stone-100 p-4 text-center">
              <p className="text-sm text-ink-soft">{label}</p>
              <p className="mt-1 font-serif text-lg text-ink">{number}</p>
            </div>
          ))}
        </div>
        <a
          href={site.whatsapp}
          className="mt-6 inline-flex items-center gap-2 rounded-full bg-pool px-6 py-3 text-sm font-medium text-white hover:bg-pool-dark"
        >
          <MessageCircle size={16} /> Message us on WhatsApp
        </a>
      </section>
    </div>
  );
}
