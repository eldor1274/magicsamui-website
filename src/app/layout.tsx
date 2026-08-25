import type { Metadata } from "next";
import { Fraunces, Inter } from "next/font/google";
import ClarityScript from "@/components/ClarityScript";
import CloudbedsScript from "@/components/CloudbedsScript";
import GaScript from "@/components/GaScript";
import Header from "@/components/Header";
import Footer from "@/components/Footer";
import ConciergeChat from "@/components/ConciergeChat";
import { site } from "@/data/site";
import { ADS_PURCHASE_SEND_TO, GOOGLE_ADS_ID } from "@/lib/analytics";
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
  description:
    "Hillside villas and suites in Koh Samui, each with its own private pool and sea view. Rated 9.8 on Booking.com. 5 min to the beach — book direct for our best rate.",
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

  return (
    <html lang="en" className={`${sans.variable} ${serif.variable} h-full`}>
      <body className="flex min-h-full flex-col font-sans antialiased">
        {tagIds.length > 0 && (
          // Seeds the gtag queue at page start so funnel events fired before
          // the lazily-loaded gtag.js arrives are replayed in order. Both the
          // GA4 property and the Google Ads tag are configured here.
          <script
            dangerouslySetInnerHTML={{
              __html: `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);${
                ADS_PURCHASE_SEND_TO
                  ? `try{if(arguments[0]==='event'&&arguments[1]==='purchase'){var p=arguments[2]||{};(function(){dataLayer.push(arguments)})('event','conversion',{send_to:'${ADS_PURCHASE_SEND_TO}',value:p.value,currency:p.currency||'THB',transaction_id:p.transaction_id||''});}}catch(e){}`
                  : ""
              }}window.gtag=gtag;gtag('js',new Date());${tagIds
                .map((id) => `gtag('config','${id}');`)
                .join("")}`,
            }}
          />
        )}
        <Header />
        <main className="flex-1">{children}</main>
        <Footer />
        <ConciergeChat />
        <CloudbedsScript />
        <ClarityScript />
        <GaScript />
      </body>
    </html>
  );
}
