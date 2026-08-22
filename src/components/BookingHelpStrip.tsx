"use client";

import { useEffect, useState } from "react";
import { MessageCircle, Phone, X } from "lucide-react";
import { site } from "@/data/site";
import { track } from "@/lib/track";

// A rescue path for guests whose payment fails inside the booking engine.
// Prompted by a real case: a guest spent over an hour across four sessions
// fighting a declined card before thinking to message us. A quiet line sits
// above the engine from the start; after STICKY_AFTER_MS on the page - by
// which point someone is usually stuck, not browsing - it also becomes a
// dismissible bar pinned to the bottom of the screen.

const STICKY_AFTER_MS = 90_000;
const DISMISS_KEY = "msv_booking_help_dismissed";

const WHATSAPP_HREF = `${site.whatsapp}?text=${encodeURIComponent(
  "Hi, I'm having trouble completing my booking on magicsamui.com - can you help?"
)}`;

function Actions({ compact }: { compact?: boolean }) {
  return (
    <div className="flex shrink-0 flex-wrap gap-2">
      <a
        href={WHATSAPP_HREF}
        onClick={() => track("booking_help_click", { channel: "whatsapp" })}
        className="inline-flex items-center gap-1.5 rounded-full bg-pool px-4 py-2 text-sm font-medium text-white transition hover:bg-pool-dark"
      >
        <MessageCircle size={15} />
        WhatsApp us
      </a>
      {!compact && (
        <a
          href={`tel:${site.phones[0].tel}`}
          onClick={() => track("booking_help_click", { channel: "call" })}
          className="inline-flex items-center gap-1.5 rounded-full border border-pool/40 px-4 py-2 text-sm font-medium text-pool transition hover:bg-pool/10"
        >
          <Phone size={15} />
          {site.phones[0].number}
        </a>
      )}
    </div>
  );
}

export default function BookingHelpStrip() {
  const [sticky, setSticky] = useState(false);

  useEffect(() => {
    try {
      if (window.sessionStorage.getItem(DISMISS_KEY)) return;
    } catch {
      /* storage blocked - still show the bar */
    }
    const timer = setTimeout(() => {
      setSticky(true);
      track("booking_help_shown");
    }, STICKY_AFTER_MS);
    return () => clearTimeout(timer);
  }, []);

  function dismiss() {
    setSticky(false);
    try {
      window.sessionStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* ignore */
    }
  }

  if (!sticky) return null;

  return (
    <>
      {sticky && (
        <div
          role="status"
          className="fixed inset-x-0 bottom-0 z-40 border-t border-sand-light bg-white/95 px-4 py-3 shadow-[0_-8px_30px_rgba(0,0,0,0.08)] backdrop-blur"
        >
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-3">
            <p className="text-sm text-ink">
              <span className="font-medium">Having trouble paying?</span>{" "}
              <span className="hidden text-ink-soft sm:inline">
                It happens — message us and Eldor will complete the booking for you.
              </span>
            </p>
            <div className="flex items-center gap-2">
              <Actions compact />
              <button
                onClick={dismiss}
                aria-label="Dismiss"
                className="rounded-full p-1.5 text-ink-soft hover:bg-stone-100"
              >
                <X size={16} />
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
