import type { Metadata } from "next";
import Link from "next/link";
import { MapPin, MessageCircle, ShoppingBasket, Fuel, Shirt, Sparkles, ShieldAlert } from "lucide-react";
import { site } from "@/data/site";

export const metadata: Metadata = {
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
