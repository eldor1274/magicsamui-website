import type { Metadata } from "next";
import { site } from "@/data/site";

export const metadata: Metadata = {
  alternates: { canonical: "/legal" },
  title: "Legal Information | Magic Suites & Villas",
  description: "Company and registration details for Magic Suites & Villas.",
  robots: { index: false },
};

// Company details live here for verification purposes (banks, payment
// providers, platform checks) rather than in the visible footer.
export default function LegalPage() {
  return (
    <div className="mx-auto max-w-3xl px-5 py-16">
      <p className="text-sm uppercase tracking-[0.3em] text-pool">Legal information</p>
      <h1 className="mt-3 font-serif text-4xl text-ink">Company Details</h1>
      <dl className="mt-8 space-y-4 rounded-2xl bg-stone-100 p-6 text-ink-soft">
        <div>
          <dt className="text-sm font-medium text-ink">Operating name</dt>
          <dd>{site.name}</dd>
        </div>
        <div>
          <dt className="text-sm font-medium text-ink">Legal entity</dt>
          <dd>{site.legalName}</dd>
        </div>
        <div>
          <dt className="text-sm font-medium text-ink">Company registration number</dt>
          <dd>{site.registrationNumber}</dd>
        </div>
        <div>
          <dt className="text-sm font-medium text-ink">Registered address</dt>
          <dd>{site.address}</dd>
        </div>
        <div>
          <dt className="text-sm font-medium text-ink">Contact</dt>
          <dd>
            {site.email} · {site.phones[0].number}
          </dd>
        </div>
      </dl>
    </div>
  );
}
