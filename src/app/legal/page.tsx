import type { Metadata } from "next";
import { site } from "@/data/site";
import { BEAM_LEGAL_NAME, paymentProcessorsOf } from "@/lib/booking/legalText";

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
  // The legal entity is the Stripe account holder (site.legalName). While a Beam config exists (active or drain:
  // Beam design S5.4) Beam is added, and the Stripe line stays while Stripe is the provider or still drains
  // (legalText.ts). The Beam merchant account must be held by the same entity (a go-live gate).
  const { stripe, beam } = paymentProcessorsOf();
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
        {beam ? (
          <div>
            <dt className="text-sm font-medium text-ink">Online payments</dt>
            {stripe && (
              <dd>
                Online payments on our own direct booking pages may be processed by Stripe. Card details are entered on
                Stripe&apos;s secure checkout page and never reach our own systems.
              </dd>
            )}
            <dd className={stripe ? "mt-1" : undefined}>
              Online payments on our own direct booking pages may be processed by Beam ({BEAM_LEGAL_NAME}). Payments are
              made on Beam&apos;s secure payment page, and card details never reach our own systems.
            </dd>
          </div>
        ) : stripe && (
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
