import type { Metadata } from "next";
import { site } from "@/data/site";

export const metadata: Metadata = {
  alternates: { canonical: "/about" },
  title: "About Us | Magic Suites & Villas",
  description: "About Magic Suites & Villas and the company behind it.",
};

export default function AboutPage() {
  return (
    <div className="mx-auto max-w-3xl px-5 py-16">
      <p className="text-sm uppercase tracking-[0.3em] text-pool">Who we are</p>
      <h1 className="mt-3 font-serif text-4xl text-ink">About Our Company</h1>

      <div className="mt-8 space-y-4 text-ink-soft leading-relaxed">
        <p>
          Magic Samui is operated by {site.legalName}, registered with the
          Department of Business Development, Ministry of Commerce, Thailand.
        </p>
        <dl className="mt-6 space-y-3 rounded-xl bg-stone-100 p-5 text-sm">
          <div className="flex justify-between border-b border-white pb-2">
            <dt className="text-ink-soft">Legal business name</dt>
            <dd className="font-medium text-ink">{site.legalName}</dd>
          </div>
          <div className="flex justify-between border-b border-white pb-2">
            <dt className="text-ink-soft">Registration number</dt>
            <dd className="font-medium text-ink">{site.registrationNumber}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-ink-soft">Address</dt>
            <dd className="font-medium text-ink text-right">{site.address}</dd>
          </div>
        </dl>
      </div>
    </div>
  );
}
