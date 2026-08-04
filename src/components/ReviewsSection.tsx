import { Star } from "lucide-react";
import { reviews, reviewStats } from "@/data/reviews";

const platformLabel: Record<string, string> = {
  booking: "Booking.com",
  airbnb: "Airbnb",
};

export default function ReviewsSection() {
  return (
    <section id="reviews" className="bg-stone-100 py-16">
      <div className="mx-auto max-w-6xl px-5">
        <div className="flex flex-wrap items-end justify-between gap-6">
          <div>
            <p className="text-sm uppercase tracking-[0.3em] text-pool">Guest reviews</p>
            <h2 className="mt-3 font-serif text-3xl text-ink">What Our Guests Say</h2>
          </div>
          <div className="flex flex-wrap gap-4">
            <a
              href={reviewStats.booking.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-4 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5 transition-shadow hover:shadow-md"
            >
              <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-pool font-serif text-lg text-white">
                {reviewStats.booking.score}
              </span>
              <span>
                <span className="block text-sm font-medium text-ink">
                  {reviewStats.booking.label} on Booking.com
                </span>
                <span className="block text-xs text-ink-soft">
                  {reviewStats.booking.count} verified guest reviews →
                </span>
              </span>
            </a>
            <a
              href={reviewStats.airbnb.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-4 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5 transition-shadow hover:shadow-md"
            >
              <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-ink font-serif text-lg text-white">
                {reviewStats.airbnb.score}
              </span>
              <span>
                <span className="block text-sm font-medium text-ink">
                  {reviewStats.airbnb.label} on Airbnb
                </span>
                <span className="block text-xs text-ink-soft">
                  {reviewStats.airbnb.count} reviews · {reviewStats.airbnb.years} years hosting →
                </span>
              </span>
            </a>
          </div>
        </div>

        <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {reviews.map((review) => (
            <figure
              key={review.name + review.country}
              className="flex flex-col rounded-2xl bg-white p-6 shadow-sm ring-1 ring-black/5"
            >
              <div className="flex items-center gap-1 text-sand">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Star key={i} size={14} fill="currentColor" strokeWidth={0} />
                ))}
              </div>
              <blockquote className="mt-3 flex-1 text-sm leading-relaxed text-ink-soft">
                &ldquo;{review.text}&rdquo;
              </blockquote>
              <figcaption className="mt-4 flex items-center justify-between border-t border-stone-100 pt-3">
                <span className="text-sm font-medium text-ink">
                  {review.name}
                  <span className="ml-2 text-xs font-normal text-ink-soft">{review.country}</span>
                </span>
                <span className="rounded-full bg-stone-100 px-2.5 py-1 text-[11px] font-medium text-ink-soft">
                  {platformLabel[review.platform]}
                </span>
              </figcaption>
            </figure>
          ))}
        </div>
      </div>
    </section>
  );
}
