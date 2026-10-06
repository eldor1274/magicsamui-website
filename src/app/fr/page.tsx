import type { Metadata } from "next";
import LocalizedLanding from "@/components/LocalizedLanding";
import { descriptionForEngine, landings, LANG_ALTERNATES } from "@/data/landings";
import { directCopySwapped } from "@/lib/booking/config";

const t = landings.fr;

export const metadata: Metadata = {
  title: t.title,
  description: descriptionForEngine(t, directCopySwapped()),
  alternates: { canonical: "/fr", languages: LANG_ALTERNATES },
};

export default function Page() {
  return <LocalizedLanding t={t} />;
}
