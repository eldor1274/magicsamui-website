"use client";

import { useState } from "react";
import { X, SendHorizontal } from "lucide-react";
import { site } from "@/data/site";

// Floating chat bubble on every page. Clicking it opens an on-page chat
// panel; sending a message hands the conversation to WhatsApp (with the
// message prefilled), where the support bot answers instantly.
export default function WhatsAppFloat() {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");

  function send() {
    const text = message.trim() || "Hi Magic Suites & Villas! I have a question.";
    window.open(
      `${site.whatsapp}?text=${encodeURIComponent(text)}`,
      "_blank",
      "noopener,noreferrer"
    );
    setMessage("");
    setOpen(false);
  }

  return (
    <div className="fixed bottom-5 right-5 z-50 flex flex-col items-end gap-3">
      {open && (
        <div className="w-[calc(100vw-40px)] max-w-[340px] overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-black/10">
          <div className="flex items-center gap-3 bg-[#075E54] p-4 text-white">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/15">
              <WhatsAppIcon size={22} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold">
                Magic Suites &amp; Villas
              </span>
              <span className="block text-xs text-white/80">
                Typically replies instantly
              </span>
            </span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close chat"
              className="rounded-full p-1 hover:bg-white/15"
            >
              <X size={18} />
            </button>
          </div>

          <div className="space-y-3 bg-[#ECE5DD] p-4">
            <div className="max-w-[85%] rounded-xl rounded-tl-none bg-white p-3 text-sm text-ink shadow-sm">
              Hi there 👋 How can we help? Ask about availability, prices, or
              anything on Samui — we reply straight away.
            </div>
          </div>

          <form
            className="flex items-center gap-2 border-t border-black/5 bg-white p-3"
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            <input
              type="text"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Type a message…"
              aria-label="Your message"
              className="min-w-0 flex-1 rounded-full bg-stone-100 px-4 py-2.5 text-sm text-ink outline-none placeholder:text-ink-soft"
            />
            <button
              type="submit"
              aria-label="Send on WhatsApp"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#25D366] text-white transition-transform hover:scale-105"
            >
              <SendHorizontal size={18} />
            </button>
          </form>
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? "Close WhatsApp chat" : "Chat with us on WhatsApp"}
        className="flex h-14 w-14 items-center justify-center rounded-full bg-[#25D366] text-white shadow-lg transition-transform hover:scale-110"
      >
        <WhatsAppIcon size={30} />
      </button>
    </div>
  );
}

function WhatsAppIcon({ size }: { size: number }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} fill="currentColor" aria-hidden="true">
      <path d="M16 3C9.4 3 4 8.3 4 14.9c0 2.6.8 5 2.3 7L4.7 27.6a1 1 0 0 0 1.2 1.3l6-1.6a12.2 12.2 0 0 0 4.1.7c6.6 0 12-5.3 12-11.9S22.6 3 16 3Zm0 21.8c-1.3 0-2.6-.3-3.7-.7l-.7-.3-3.6 1 1-3.4-.5-.7a9.7 9.7 0 0 1-1.9-5.8c0-5.4 4.2-9.7 9.4-9.7s9.4 4.3 9.4 9.7-4.2 9.9-9.4 9.9Zm5.2-7.2c-.3-.2-1.7-.9-2-1-.3-.1-.5-.2-.7.1-.2.3-.8 1-.9 1.2-.2.2-.3.2-.6.1a7.7 7.7 0 0 1-3.9-3.4c-.3-.5.3-.5.8-1.6.1-.2 0-.4 0-.6l-.9-2.2c-.2-.6-.5-.5-.7-.5h-.6c-.2 0-.5.1-.8.4-.3.3-1 1-1 2.5s1.1 2.9 1.2 3.1c.2.2 2.1 3.2 5.1 4.5.7.3 1.3.5 1.7.6.7.2 1.4.2 1.9.1.6-.1 1.7-.7 2-1.4.2-.7.2-1.3.2-1.4-.1-.1-.3-.2-.6-.4Z" />
    </svg>
  );
}
