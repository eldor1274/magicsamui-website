import type { Metadata } from "next";
import { site } from "@/data/site";

export const metadata: Metadata = {
  alternates: { canonical: "/security" },
  title: "Report a Security Issue | Magic Suites & Villas",
  description:
    "How to tell Magic Suites & Villas about a security weakness in magicsamui.com or our direct booking pages, and what we ask of researchers.",
};

// Responsible-disclosure page for the site, the own booking pages and the
// WhatsApp assistant. Companion to /.well-known/security.txt (RFC 9116),
// which points here as its Policy. Plain and truthful: the owner looks after
// the systems himself, and there is no paid bug-bounty programme.
export default function SecurityPage() {
  const whatsappNumber = site.phones[0].number;
  return (
    <div className="mx-auto max-w-3xl px-5 py-16">
      <p className="text-sm uppercase tracking-[0.3em] text-pool">Security</p>
      <h1 className="mt-3 font-serif text-4xl text-ink">Report a security issue</h1>
      <p className="mt-6 text-ink-soft">
        {site.name} is a small, family-run villa business in Koh Samui, Thailand, operated by {site.legalName}.
        We run our own website and direct booking pages, and we care about keeping our guests&apos; details and
        payments safe. If you have found a weakness, we would like to hear about it.
      </p>

      <h2 className="mt-10 font-serif text-2xl text-ink">How to reach us</h2>
      <p className="mt-3 text-ink-soft">
        Email{" "}
        <a href={`mailto:${site.email}?subject=Security`} className="text-pool underline">
          {site.email}
        </a>{" "}
        with &ldquo;Security&rdquo; in the subject line. It goes to the owner, who looks after our website and systems
        personally; we do not have a separate security team. For something urgent you can also message{" "}
        <a href={site.whatsapp} className="text-pool underline" rel="noopener noreferrer">
          {whatsappNumber}
        </a>{" "}
        on WhatsApp.
      </p>
      <p className="mt-3 text-ink-soft">
        Please include what you found, where (the page or address), and the steps to see it again. Screenshots help.
        Do not send us anyone else&apos;s personal details - a description is enough.
      </p>

      <h2 className="mt-10 font-serif text-2xl text-ink">What is ours</h2>
      <ul className="mt-3 list-disc space-y-2 pl-6 text-ink-soft">
        <li>magicsamui.com and every page on it</li>
        <li>our direct booking pages and their payment step</li>
        <li>the automated replies of our WhatsApp assistant</li>
      </ul>
      <p className="mt-3 text-ink-soft">
        Not ours, so please report these to their own teams: the Cloudbeds booking engine, the Beam and Stripe payment
        pages (card details are entered there and never reach our own systems), and our listings on Booking.com, Airbnb
        and other platforms.
      </p>

      <h2 className="mt-10 font-serif text-2xl text-ink">Ground rules</h2>
      <ul className="mt-3 list-disc space-y-2 pl-6 text-ink-soft">
        <li>Test only with your own details and your own bookings.</li>
        <li>
          Do not look at, download or change other guests&apos; information. If you come across it by accident, stop and
          tell us.
        </li>
        <li>Do not complete a real payment as part of a test - stop at the payment page and tell us what you found.</li>
        <li>No flooding, denial of service, automated mass scanning, or tricking our staff.</li>
        <li>Give us time to fix the issue before you share it publicly.</li>
      </ul>

      <h2 className="mt-10 font-serif text-2xl text-ink">What we will do</h2>
      <ul className="mt-3 list-disc space-y-2 pl-6 text-ink-soft">
        <li>Reply within five working days to say we have received your report.</li>
        <li>Keep you informed while we look into it and fix it.</li>
        <li>Thank you publicly on this page if you would like us to.</li>
      </ul>
      <p className="mt-3 text-ink-soft">
        We are a small business and do not run a paid bug-bounty programme, but we are genuinely grateful for reports
        made in good faith, and we will not take action against anyone who follows the rules above.
      </p>

      <p className="mt-10 text-sm text-ink-soft">
        This information is also published in the standard machine-readable form at{" "}
        <a href="/.well-known/security.txt" className="text-pool underline">
          /.well-known/security.txt
        </a>
        . Last updated 9 November 2026.
      </p>
    </div>
  );
}
