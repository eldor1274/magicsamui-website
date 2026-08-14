import type { Metadata } from "next";
import PointsAdmin from "@/components/PointsAdmin";

export const metadata: Metadata = {
  title: "Points admin",
  robots: { index: false, follow: false },
};

export default function PointsAdminPage() {
  return (
    <div className="mx-auto max-w-3xl px-5 py-16">
      <h1 className="font-serif text-3xl text-ink">Points admin</h1>
      <p className="mt-2 text-sm text-ink-soft">
        Find a guest, give them the discount, then clear the points here.
      </p>
      <div className="mt-8">
        <PointsAdmin />
      </div>
    </div>
  );
}
