import type { Metadata } from "next";
import { Fraunces, Inter } from "next/font/google";
import ClarityScript from "@/components/ClarityScript";
import CloudbedsScript from "@/components/CloudbedsScript";
import GaScript from "@/components/GaScript";
import Header from "@/components/Header";
import Footer from "@/components/Footer";
import WhatsAppFab from "@/components/WhatsAppFab";
import { site } from "@/data/site";
import { GOOGLE_ADS_ID } from "@/lib/analytics";
import { directCopySwapped, finishesLiveStripePayments, getPublicBookingConfig, resolveBookingEngine } from "@/lib/booking/config";
import "./globals.css";

const sans = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
});

const serif = Fraunces({
  variable: "--font-serif",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: "Luxury Private Pool Villas in Koh Samui | Magic Suites",
  // No best-rate promise while our own engine (fee shown openly) serves /booking without the DIRECT code (BOOKING_DIRECT_PROMO=off).
  description:
    directCopySwapped()
      ? "Koh Samui villas and suites, most with a private pool: 3-bedroom stays for 6 and the whole Magic Villa (5 bedrooms, sleeps 10). Book direct with live prices."
      : "Koh Samui villas and suites, most with a private pool: 3-bedroom stays for 6 and the whole Magic Villa (5 bedrooms, sleeps 10). Book direct for our best rate.",
  metadataBase: new URL(`https://${site.domain}`),
  openGraph: {
    type: "website",
    siteName: site.name,
    locale: "en_US",
    images: [
      {
        url: "/images/home/Magic-Suites-50-2.jpg",
        width: 1200,
        height: 630,
        alt: "Magic Suites private pool villa at sunset",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
  },
  verification: {
    google: process.env.NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const gaId = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID;
  const tagIds = [gaId, GOOGLE_ADS_ID].filter(Boolean);
  // The booking preview is tracked only while it takes REAL payments (stripe-live on production: Stage C
  // and the soft launch run there). Demo / test / MOCK payments never reach GA4 or Google Ads.
  const previewTracked = getPublicBookingConfig().live;
  // The soft-launch return page also while live Stripe payments are only being FINISHED (emergency stop,
  // provider drain): paid bookings are still confirmed there, and their purchase must still be recorded.
  const previewReturnTracked = previewTracked || finishesLiveStripePayments();

  return (
    <html lang="en" className={`${sans.variable} ${serif.variable} h-full`}>
      <body className="flex min-h-full flex-col font-sans antialiased">
        {tagIds.length > 0 && (
          // Seeds the gtag queue at page start so funnel events fired before
          // the lazily-loaded gtag.js arrives are replayed in order. Both the
          // GA4 property and the Google Ads tag are configured here.
          <script
            dangerouslySetInnerHTML={{
              __html: `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}window.gtag=gtag;gtag('js',new Date());${tagIds
                .map((id) => `gtag('config','${id}');`)
                .join("")}`,
            }}
          />
        )}
        <Header />
        <main className="flex-1">{children}</main>
        <Footer />
        {/* BOOKING_ENGINE=own: /booking serves our own engine (default: the Cloudbeds engine, unchanged). */}
        <WhatsAppFab ownEngine={resolveBookingEngine() === "own"} previewTracked={previewTracked} />
        <CloudbedsScript ownEngine={resolveBookingEngine() === "own"} />
        <ClarityScript />
        <GaScript previewTracked={previewTracked} previewReturnTracked={previewReturnTracked} />
      </body>
    </html>
  );
}
