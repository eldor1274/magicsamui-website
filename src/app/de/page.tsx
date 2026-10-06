import type { Metadata } from "next";
import LocalizedLanding from "@/components/LocalizedLanding";
import { descriptionForEngine, landings, LANG_ALTERNATES } from "@/data/landings";
import { resolveBookingEngine } from "@/lib/booking/config";

const t = landings.de;

export const metadata: Metadata = {
  title: t.title,
  description: descriptionForEngine(t, resolveBookingEngine() === "own"),
  alternates: { canonical: "/de", languages: LANG_ALTERNATES },
};

export default function Page() {
  return <LocalizedLanding t={t} />;
}
