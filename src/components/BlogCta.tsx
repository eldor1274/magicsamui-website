import Link from "next/link";
import BookNowButton from "./BookNowButton";

export default function BlogCta() {
  return (
    <div className="mt-10 rounded-2xl bg-ink px-8 py-8 text-center text-stone-50">
      <h3 className="font-serif text-xl text-sand">Stay at Magic Suites &amp; Villas — Koh Samui</h3>
      <p className="mx-auto mt-2 max-w-lg text-sm text-stone-100/80">
        Private pool suites and villas on a hillside overlooking the Gulf of
        Thailand, 2 minutes from Choeng Mon Beach.
      </p>
      <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
        <BookNowButton />
        <Link
          href="/rooms"
          className="inline-flex items-center justify-center rounded-full border border-stone-100/40 px-6 py-3 text-sm font-medium text-stone-50 hover:bg-white/10"
        >
          Explore Rooms
        </Link>
      </div>
    </div>
  );
}
