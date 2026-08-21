import Image from "next/image";
import Link from "next/link";
import { MessageCircle, Star } from "lucide-react";
import HtmlLang from "@/components/HtmlLang";
import JsonLd from "@/components/JsonLd";
import { resortJsonLd } from "@/lib/structuredData";
import { rooms } from "@/data/rooms";
import { site } from "@/data/site";
import { LANG_LINKS, type Landing } from "@/data/landings";

// Shared template for the localized landing pages. The header and footer stay
// English (global chrome); everything inside is in the visitor's language,
// including direction for Hebrew.

const featured = ["honeymoon-suite", "sunrise-suite", "seaview-suite"]
  .map((slug) => rooms.find((r) => r.slug === slug))
  .filter((r): r is NonNullable<typeof r> => Boolean(r));

export default function LocalizedLanding({ t }: { t: Landing }) {
  return (
    <div dir={t.dir} lang={t.htmlLang}>
      <HtmlLang lang={t.htmlLang} />
      <JsonLd data={resortJsonLd()} />

      <section className="relative flex h-[70vh] min-h-[480px] w-full items-end">
        <Image
          src="/images/home/Magic-Suites-50-2.jpg"
          alt={t.h1}
          fill
          preload
          fetchPriority="high"
          quality={60}
          sizes="100vw"
          className="object-cover"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/25 to-black/10" />
        <div className="relative mx-auto w-full max-w-6xl px-5 pb-14 text-stone-50">
          <p className="text-sm font-semibold uppercase tracking-[0.3em] text-stone-100/90">
            {t.eyebrow}
          </p>
          <h1 className="mt-4 max-w-xl font-serif text-4xl leading-tight sm:text-5xl">
            {t.h1}
          </h1>
          <p className="mt-4 max-w-lg text-stone-100/90">{t.sub}</p>
          <div className="mt-8 flex flex-wrap gap-4">
            <Link
              href="/booking"
              className="rounded-full bg-pool px-7 py-3 font-medium text-white transition hover:bg-pool-dark"
            >
              {t.ctaBook}
            </Link>
            <a
              href={site.whatsapp}
              className="flex items-center gap-2 rounded-full bg-white/90 px-6 py-3 font-medium text-ink backdrop-blur transition hover:bg-white"
            >
              <MessageCircle size={17} className="text-pool" />
              {t.ctaWhats}
            </a>
          </div>
          <p className="mt-6 flex items-center gap-1.5 text-sm text-stone-100/85">
            <Star size={13} className="text-sand-light" fill="currentColor" strokeWidth={0} />
            {t.reviewsLine}
          </p>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-5 py-16">
        <h2 className="font-serif text-3xl text-ink">{t.roomsTitle}</h2>
        <p className="mt-2 text-ink-soft">{t.roomsSub}</p>
        <div className="mt-8 grid gap-6 sm:grid-cols-3">
          {featured.map((room) => (
            <Link
              key={room.slug}
              href={`/rooms/${room.slug}`}
              className="group overflow-hidden rounded-2xl bg-stone-100"
            >
              <div className="relative aspect-[4/3] overflow-hidden">
                <Image
                  src={room.heroImage.src}
                  alt={room.heroImage.alt}
                  fill
                  quality={60}
                  sizes="(max-width: 640px) 100vw, 33vw"
                  className="object-cover transition-transform duration-500 group-hover:scale-105"
                />
              </div>
              <div className="p-4">
                <p className="font-medium text-ink">{room.name}</p>
                <p className="mt-1 text-sm text-ink-soft">
                  {room.area.sqm} m² · {room.guests} {t.guestsWord}
                </p>
              </div>
            </Link>
          ))}
        </div>
        <Link
          href="/rooms"
          className="mt-8 inline-block rounded-full border border-pool px-6 py-2.5 font-medium text-pool transition hover:bg-pool hover:text-white"
        >
          {t.viewAll}
        </Link>
      </section>

      <section className="bg-stone-100">
        <div className="mx-auto max-w-6xl px-5 py-16">
          <h2 className="font-serif text-3xl text-ink">{t.perksTitle}</h2>
          <div className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {t.perks.map((perk) => (
              <div key={perk.title} className="rounded-2xl bg-white p-6">
                <p className="font-medium text-ink">{perk.title}</p>
                <p className="mt-2 text-sm text-ink-soft">{perk.text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-5 py-16">
        <div className="grid items-center gap-10 lg:grid-cols-2">
          <div>
            <h2 className="font-serif text-3xl text-ink">{t.locationTitle}</h2>
            <p className="mt-4 text-ink-soft">{t.locationText}</p>
          </div>
          <div className="rounded-2xl bg-stone-100 p-8">
            <h3 className="font-serif text-2xl text-ink">{t.ctaTitle}</h3>
            <p className="mt-3 text-ink-soft">{t.ctaText}</p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Link
                href="/booking"
                className="rounded-full bg-pool px-6 py-2.5 font-medium text-white transition hover:bg-pool-dark"
              >
                {t.ctaBook}
              </Link>
              <a
                href={site.whatsapp}
                className="rounded-full border border-pool px-6 py-2.5 font-medium text-pool transition hover:bg-pool hover:text-white"
              >
                WhatsApp
              </a>
            </div>
          </div>
        </div>
      </section>

      <section className="border-t border-stone-100 py-8" dir="ltr">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-5 text-sm text-ink-soft">
          <span>{t.langNote}:</span>
          {LANG_LINKS.map((lang) => (
            <Link
              key={lang.code}
              href={lang.href}
              className={
                lang.code === t.code
                  ? "font-medium text-ink"
                  : "text-pool hover:underline"
              }
            >
              {lang.label}
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
