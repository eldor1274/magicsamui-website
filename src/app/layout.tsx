import type { Metadata } from "next";
import { Fraunces, Inter } from "next/font/google";
import ClarityScript from "@/components/ClarityScript";
import CloudbedsScript from "@/components/CloudbedsScript";
import GaScript from "@/components/GaScript";
import Header from "@/components/Header";
import Footer from "@/components/Footer";
import ConciergeChat from "@/components/ConciergeChat";
import { site } from "@/data/site";
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
  title: "Magic Suites & Villas | Private Pool Villas in Koh Samui",
  description:
    "Magic Suites & Villas offers 2 villas and 4 private pool suites on a hillside overlooking the gulf of Thailand in Koh Samui, 5 minutes from Choeng Mon Beach.",
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

  return (
    <html lang="en" className={`${sans.variable} ${serif.variable} h-full`}>
      <body className="flex min-h-full flex-col font-sans antialiased">
        {gaId && (
          // Seeds the gtag queue at page start so funnel events fired before
          // the lazily-loaded gtag.js arrives are replayed in order.
          <script
            dangerouslySetInnerHTML={{
              __html: `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}window.gtag=gtag;gtag('js',new Date());gtag('config','${gaId}');`,
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
