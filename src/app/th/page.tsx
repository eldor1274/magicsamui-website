import type { Metadata } from "next";
import LocalizedLanding from "@/components/LocalizedLanding";
import { landings, LANG_ALTERNATES } from "@/data/landings";

const t = landings.th;

export const metadata: Metadata = {
  title: t.title,
  description: t.description,
  alternates: { canonical: "/th", languages: LANG_ALTERNATES },
};

export default function Page() {
  return <LocalizedLanding t={t} />;
}
