import CloudbedsImmersive from "@/components/CloudbedsImmersive";
import PromoHint from "@/components/PromoHint";
import BookingHelpStrip from "@/components/BookingHelpStrip";
import ScrollDiagGate from "@/components/ScrollDiagGate";

// The Cloudbeds booking engine page: what /booking renders by default
// (BOOKING_ENGINE unset or "cloudbeds"), and the /booking/classic fallback
// once our own engine serves /booking. Unchanged from the original page.
export default function ClassicBookingPage() {
  return (
    <div className="mx-auto max-w-6xl px-5 py-10">
      <p className="text-sm uppercase tracking-[0.3em] text-pool">Book direct</p>
      <h1 className="mt-3 font-serif text-4xl text-ink">Book Your Stay</h1>
      <p className="mt-4 max-w-2xl text-ink-soft">
        Live availability and secure payment, right here on our site.
      </p>
      <div className="mt-5 max-w-2xl">
        <PromoHint />
      </div>
      <div className="mt-3 max-w-2xl">
        <BookingHelpStrip />
      </div>
      <div className="mt-6">
        <CloudbedsImmersive />
      </div>
      {/* Inert unless the URL carries ?diag=1 - see the component. */}
      <ScrollDiagGate />
    </div>
  );
}
