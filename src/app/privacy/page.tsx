import type { Metadata } from "next";
import { site } from "@/data/site";

export const metadata: Metadata = {
  alternates: { canonical: "/privacy" },
  title: "Privacy Policy | Magic Suites & Villas",
  description:
    "How Magic Suites & Villas collects, uses and protects your personal information when you book, contact us or use our website.",
};

const UPDATED = "15 August 2026";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="font-serif text-2xl text-ink">{title}</h2>
      <div className="mt-3 space-y-3 text-ink-soft">{children}</div>
    </section>
  );
}

export default function PrivacyPage() {
  return (
    <div className="mx-auto max-w-3xl px-5 py-16">
      <p className="text-sm uppercase tracking-[0.3em] text-pool">Legal</p>
      <h1 className="mt-3 font-serif text-4xl text-ink">Privacy Policy</h1>
      <p className="mt-4 text-sm text-ink-soft">Last updated: {UPDATED}</p>

      <p className="mt-8 text-ink-soft">
        This policy explains what personal information {site.name} collects, why
        we collect it, who we share it with, and the choices you have. It covers
        this website, our booking process, and the messaging assistant we use to
        answer guest questions.
      </p>

      <Section title="Who we are">
        <p>
          {site.name} is operated by {site.legalName}, company registration
          number {site.registrationNumber}, {site.address}. We are the data
          controller for the information described here.
        </p>
        <p>
          For any privacy question or request, contact{" "}
          <a href={`mailto:${site.email}`} className="text-pool underline">
            {site.email}
          </a>{" "}
          or {site.phones[0].number}.
        </p>
      </Section>

      <Section title="Information we collect">
        <p className="font-medium text-ink">When you make a booking</p>
        <p>
          Your name, email address, phone number, country, stay dates, the room
          or villa booked, the amount paid, and any requests you make (for
          example arrival time, airport transfer, or dietary preferences).
          Bookings are processed through our booking system, Cloudbeds. Card
          details are handled by Cloudbeds and its payment providers — we never
          see or store your full card number.
        </p>

        <p className="font-medium text-ink">When you contact us</p>
        <p>
          If you use our contact form we receive the name, email address or
          phone number, and message you provide. If you join the waiting list
          for our new villas we receive your email address only.
        </p>

        <p className="font-medium text-ink">When you message our assistant</p>
        <p>
          We answer guest questions on WhatsApp, Messenger, Instagram, and
          through the chat window on this website. We receive your phone number
          or platform account, your name where the platform provides it, and the
          content of your messages, including any preferences or dietary
          information you choose to share.
        </p>

        <p className="font-medium text-ink">When you check your guest points</p>
        <p>
          Our points page asks for the phone number you booked with, purely to
          find your balance. The number is used for that lookup and is not
          stored by the website or added to any marketing list.
        </p>

        <p className="font-medium text-ink">Automatically, as you browse</p>
        <p>
          Your IP address, device and browser type, pages viewed, referring
          site, and how you interact with pages. This includes session
          recordings and heat maps — the next section explains this in full.
        </p>
      </Section>

      <Section title="Cookies, analytics and session recording">
        <p>
          We use cookies and similar technologies that are necessary for the
          site and booking engine to work, and others that help us understand
          how the site is used.
        </p>
        <p>
          <span className="font-medium text-ink">Google Analytics</span> tells us
          how many people visit, which pages they read, and how they arrived.
        </p>
        <p>
          <span className="font-medium text-ink">Microsoft Clarity</span> records
          how visitors move through the site, including mouse movement,
          scrolling and clicks, and can replay that as an anonymous session
          recording. We use it to find pages that are confusing or broken.
          Clarity masks text entered into form fields by default, and we do not
          use it to identify individuals.
        </p>
        <p>
          <span className="font-medium text-ink">Cloudbeds</span> sets cookies
          needed to hold your booking while you complete it.
        </p>
        <p>
          Some pages embed third-party content, such as a transport booking
          widget from 12Go, which may set its own cookies.
        </p>
        <p>
          You can block or delete cookies in your browser settings. Doing so may
          stop the booking engine working correctly. You can opt out of Google
          Analytics using Google&apos;s{" "}
          <a
            href="https://tools.google.com/dlpage/gaoptout"
            className="text-pool underline"
            rel="noopener noreferrer"
            target="_blank"
          >
            browser add-on
          </a>
          .
        </p>
      </Section>

      <Section title="Advertising">
        <p>
          We advertise this website through Google. Google and its partners use
          cookies to show our ads on other sites you visit, and to measure
          whether those ads led to a booking. This may include remarketing —
          showing our ads to people who have already visited magicsamui.com.
        </p>
        <p>
          We do not upload guest lists, email addresses or phone numbers to
          advertising platforms, and we do not use booking or conversation
          content to target ads.
        </p>
        <p>
          You can control the ads you see through{" "}
          <a
            href="https://myadcenter.google.com/"
            className="text-pool underline"
            rel="noopener noreferrer"
            target="_blank"
          >
            Google My Ad Center
          </a>
          , or opt out of personalised advertising from many companies at{" "}
          <a
            href="https://optout.aboutads.info/"
            className="text-pool underline"
            rel="noopener noreferrer"
            target="_blank"
          >
            optout.aboutads.info
          </a>
          .
        </p>
      </Section>

      <Section title="How we use your information">
        <p>
          To take and manage your booking; to answer your questions before,
          during and after a stay; to arrange things you ask for such as airport
          transfers or breakfast; to run our guest points programme; to keep the
          website secure and working; to understand how the site is used; to
          advertise our villas; and to meet our legal and accounting
          obligations, including guest registration requirements under Thai law.
        </p>
        <p>
          We rely on the performance of our contract with you for booking and
          hosting, your consent for optional analytics and advertising cookies,
          our legitimate interest in running and improving the business, and
          legal obligation where the law requires us to keep records.
        </p>
      </Section>

      <Section title="Automated message drafting">
        <p>
          Guest messages are answered by an assistant that uses artificial
          intelligence provided by Anthropic to draft replies. Your message
          content is sent to Anthropic for that purpose. A person can and does
          take over any conversation. We do not make automated decisions that
          have a legal or similarly significant effect on you.
        </p>
      </Section>

      <Section title="Who we share information with">
        <p>
          We do not sell your personal information, and we do not share it for
          anyone else&apos;s marketing. We share only what is needed with the
          service providers who help us operate:
        </p>
        <ul className="ml-5 list-disc space-y-1">
          <li>Cloudbeds — booking system and payment processing</li>
          <li>Anthropic — drafting replies to guest messages</li>
          <li>Meta — WhatsApp, Messenger and Instagram messaging</li>
          <li>Google — analytics, advertising, and email delivery</li>
          <li>Microsoft — Clarity analytics</li>
          <li>Vercel and DigitalOcean — website and server hosting</li>
        </ul>
        <p>
          If you book through a travel site such as Booking.com, Airbnb, Expedia
          or Agoda, that company has its own privacy policy covering the
          information you gave them, and they pass us what we need to host you.
        </p>
        <p>
          We may also disclose information where we are legally required to, for
          example to Thai immigration or tax authorities.
        </p>
      </Section>

      <Section title="Where your information goes">
        <p>
          We are based in Thailand, and the providers above operate servers
          outside Thailand, including in the United States, Singapore and the
          European Union. Where information about visitors from the European
          Economic Area or the United Kingdom is transferred abroad, our
          providers rely on standard contractual clauses or equivalent
          safeguards.
        </p>
      </Section>

      <Section title="How long we keep it">
        <p>
          Booking records are kept for as long as needed to run the business and
          to satisfy Thai accounting and guest-registration requirements. Guest
          messages are kept so returning guests get continuity of service.
          Points records are kept for the life of the points, which expire three
          years after a stay. Analytics data is kept according to each
          provider&apos;s standard retention period.
        </p>
        <p>
          If you would like your information deleted sooner, email us and we
          will remove what we are not legally required to keep.
        </p>
      </Section>

      <Section title="How we protect your information">
        <p>
          This website and our messaging server are served only over encrypted
          HTTPS connections. Messages on WhatsApp, Messenger and Instagram are
          carried over Meta&apos;s own encrypted interfaces. Payment card details
          are handled by Cloudbeds and its payment providers and never reach our
          own systems.
        </p>
        <p>
          Access to guest records is limited to the owner and the systems
          described above. Internal tools that display guest information require
          a password or secret key and are not publicly listed. Our server is
          backed up daily.
        </p>
        <p>
          No system is completely secure, and we cannot guarantee absolute
          security. If a breach affects your personal information, we will
          notify you and the relevant authority where the law requires it.
        </p>
      </Section>

      <Section title="Your rights">
        <p>
          You can ask us for a copy of the information we hold about you, to
          correct it, to delete it, to restrict or object to how we use it, to
          receive it in a portable form, and to withdraw consent for analytics
          or advertising cookies at any time. Guests in Thailand have these
          rights under the Personal Data Protection Act; visitors in the
          European Economic Area and the United Kingdom have equivalent rights
          under the GDPR.
        </p>
        <p>
          Email{" "}
          <a href={`mailto:${site.email}`} className="text-pool underline">
            {site.email}
          </a>{" "}
          and we will respond within 30 days. You also have the right to
          complain to your local data protection authority.
        </p>
      </Section>

      <Section title="Children">
        <p>
          Our website and services are intended for adults. We do not knowingly
          collect information from children under 16 other than the names and
          ages of children included in a family booking, which are provided by
          the adult making the booking.
        </p>
      </Section>

      <Section title="Changes to this policy">
        <p>
          We may update this policy as our business or the law changes. The date
          at the top shows when it was last revised, and the current version is
          always available at magicsamui.com/privacy.
        </p>
      </Section>

      <div className="mt-12 rounded-2xl bg-stone-100 p-6 text-sm text-ink-soft">
        <p className="font-medium text-ink">Questions about your data?</p>
        <p className="mt-2">
          Email{" "}
          <a href={`mailto:${site.email}`} className="text-pool underline">
            {site.email}
          </a>{" "}
          or message us on WhatsApp at {site.phones[0].number}. Company details
          are published at{" "}
          <a href="/legal" className="text-pool underline">
            magicsamui.com/legal
          </a>
          .
        </p>
      </div>
    </div>
  );
}
