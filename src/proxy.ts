import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Spam pages injected during the old WordPress hack still linger in Google's
// index. They 404 on the new site, but 404s take months to purge — 410 Gone
// tells Google the removal is deliberate and gets them dropped much faster.
// Legit old URLs never reach here: next.config redirects run before proxy.
const SPAM_EXACT = new Set([
  "profesionalen-analiz",
  "fr-bingo",
  "najboljsa-spletna-igralnica",
  "many-years-gate",
  "fordele-ved-ojeblikkelige-bankoverforsler",
  "most-reliable-online-casinos",
  "mobilspel-pa-bitcoin-casinon",
  "best-recreational-cannabis-dispensary",
  "suomalainen-pelikulttuuri-taikauskon-silmin",
  "melbet-vhod-v-moldove-obzor",
  "top-tier-gaming-platforms-compared",
  "melbet-zerkalo-obzor-bukmekera-kyrgyzstan",
  "symboler-och-betallinjer-en-nyborjarguide",
  "best-apps-for-online-casinos",
  "kak-funktsionirujut-servery-i-vebhosting",
  "ozwin-casino-australia-review-941",
  "fenntarthato-penzugyi-strategia-a-szerencsejatek",
  "yeni-balayanlar-ucun-mostbet-kazinolarnda-uurlu",
  "top-pragmatic-play-games-at-spinmama",
  "unveiling-spinaway-review-where-innovation-dances",
  "chto-takoe-mashinnoe-obuchenie-dostupnymi-terminami",
  "progressiivisten-jattipottien-jannitys-voittojen-maksimointi-sportunalla",
  "zaklady-kasinovych-hier-pre-kadeho-zaiatonika",
  "den-juridiska-landskapet-for-online-spel",
  "fastest-web-hosting-company-from-2024",
  "forstelse-av-lagar-kring-kasinoverksamhet-i",
  "main-section-seattles-premier-cannabis-dispensary",
  "qumar-oyunlarnda-maliyy-idarciliyi-nec-olmaldr",
  "pochemu-posledovatelnost-operatsij-vazhna-dlja-ux",
  "vikten-av-ssl-kryptering-for-casinon",
  "texas-online-casinos-best-sweepstakes-ratings-2026",
  "are-gambling-laws-in-greece-permitting-which",
]);

// Catches spam variants not yet seen in search results.
const SPAM_PATTERN =
  /casino|kasino|kazino|gambl|igralnica|bingo|melbet|mostbet|bukmeker|zerkalo|spinmama|spinaway|cannabis|dispensary|sweepstake|jattipot|pelikulttuuri|szerencsejatek|qumar|pragmatic-play|betallinjer|mobilspel|kasinoverksamhet/i;

export function proxy(request: NextRequest) {
  const slug = request.nextUrl.pathname.replace(/^\/+|\/+$/g, "");
  if (!slug.includes("/") && (SPAM_EXACT.has(slug) || SPAM_PATTERN.test(slug))) {
    return new NextResponse("Gone", { status: 410 });
  }
  return NextResponse.next();
}

export const config = {
  matcher: "/((?!_next|api|images|videos|blog|rooms|guide|booking|contact|legal|rentals|favicon.ico|sitemap.xml|robots.txt).*)",
};
