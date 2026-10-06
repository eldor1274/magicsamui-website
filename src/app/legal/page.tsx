import type { Metadata } from "next";
import { site } from "@/data/site";
import { getPublicBookingConfig } from "@/lib/booking/config";

export const metadata: Metadata = {
  alternates: { canonical: "/legal" },
  title: "Legal Information | Magic Suites & Villas",
  description: "Company and registration details for Magic Suites & Villas.",
  robots: { index: false },
};

// Company details live here for verification purposes (banks, payment
// providers, platform checks) rather than in the visible footer.
export default function LegalPage() {
  // Shown once Stripe is the configured provider (BOOKING_PAYMENT_PROVIDER=stripe). Worded so it is true in
  // every phase: during Stage B and the soft launch the public /booking is still the Cloudbeds engine.
  // The legal entity is the Stripe account holder (site.legalName).
  const stripe = getPublicBookingConfig().provider === "stripe";
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
          <dt className="text-sm font-medium text-ink">Registration number</dt>
          <dd>{site.registrationNumber}</dd>
        </div>
        <div>
          <dt className="text-sm font-medium text-ink">Registered address</dt>
          <dd>{site.registeredAddress}</dd>
        </div>
        <div>
          <dt className="text-sm font-medium text-ink">Villas</dt>
          <dd>{site.address}</dd>
        </div>
        <div>
          <dt className="text-sm font-medium text-ink">Contact</dt>
          <dd>
            {site.email} · {site.phones[0].number}
          </dd>
        </div>
        {stripe && (
          <div>
            <dt className="text-sm font-medium text-ink">Online payments</dt>
            <dd>
              Online payments on our own direct booking pages may be processed by Stripe. Card details are entered on
              Stripe&apos;s secure checkout page and never reach our own systems.
            </dd>
          </div>
        )}
      </dl>
    </div>
  );
}
