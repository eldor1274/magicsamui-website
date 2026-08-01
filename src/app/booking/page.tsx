import type { Metadata } from "next";
import CloudbedsImmersive from "@/components/CloudbedsImmersive";

export const metadata: Metadata = {
  alternates: { canonical: "/booking" },
  title: "Book Your Stay | Magic Suites & Villas",
  description:
    "Check live availability and book your private pool suite or villa at Magic Suites & Villas, Koh Samui — best rate, always, when you book direct.",
};

export default function BookingPage() {
  return (
    <div className="mx-auto max-w-6xl px-5 py-10">
      <p className="text-sm uppercase tracking-[0.3em] text-pool">Book direct</p>
      <h1 className="mt-3 font-serif text-4xl text-ink">Book Your Stay</h1>
      <p className="mt-4 max-w-2xl text-ink-soft">
        Live availability and secure payment, right here on our site.
      </p>
      <div className="mt-8">
        <CloudbedsImmersive />
      </div>
    </div>
  );
}
