"use client";

import { useEffect, useRef, useState } from "react";
import { MessageCircle, X, SendHorizontal } from "lucide-react";
import { track } from "@/lib/track";

// Floating concierge chat. Talks to the Magic Suites AI bot (same brain as
// the WhatsApp/Messenger/Instagram concierge) over its webchat endpoint, so
// the whole conversation stays on the site.
const BOT_URL =
  typeof window !== "undefined" && window.location.hostname === "localhost"
    ? "http://localhost:3100"
    : "https://bot.magicsuitesbot.com";

const WA_LINK = "https://wa.me/66952466011";

interface ChatMessage {
  role: "guest" | "bot";
  text: string;
}

const GREETING: ChatMessage = {
  role: "bot",
  text: "Hi there 👋 Ask me anything about the suites, availability, prices, or Koh Samui — I reply instantly.",
};

function getSessionId() {
  const KEY = "magic-webchat-session";
  let id = sessionStorage.getItem(KEY);
  if (!id) {
    id = `webchat_${crypto.randomUUID()}`;
    sessionStorage.setItem(KEY, id);
  }
  return id;
}

function linkify(text: string) {
  const parts = text.split(/(https?:\/\/[^\s]+)/g);
  return parts.map((part, i) =>
    /^https?:\/\//.test(part) ? (
      <a
        key={i}
        href={part}
        target="_blank"
        rel="noopener noreferrer"
        className="break-all text-pool underline"
      >
        {part}
      </a>
    ) : (
      part
    )
  );
}

export default function ConciergeChat() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([GREETING]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy, open]);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setMessages((m) => [...m, { role: "guest", text }]);
    setBusy(true);
    track("chat_message_sent");
    try {
      const res = await fetch(`${BOT_URL}/webchat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: getSessionId(), message: text }),
      });
      const data = await res.json();
      setMessages((m) => [...m, { role: "bot", text: data.reply || "Sorry, I did not catch that — could you try again?" }]);
    } catch {
      setMessages((m) => [
        ...m,
        { role: "bot", text: `Sorry — the chat is unavailable right now. Please message us on WhatsApp instead: ${WA_LINK}` },
      ]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed bottom-5 right-5 z-50 flex flex-col items-end gap-3">
      {open && (
        <div className="flex max-h-[70vh] w-[calc(100vw-40px)] max-w-[360px] flex-col overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-black/10">
          <div className="flex items-center gap-3 bg-pool p-4 text-white">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/15">
              <MessageCircle size={20} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold">
                Magic Suites &amp; Villas
              </span>
              <span className="block text-xs text-white/80">
                Ask us anything — we reply instantly
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

          <div ref={bodyRef} className="min-h-[200px] flex-1 space-y-3 overflow-y-auto bg-stone-100 p-4">
            {messages.map((m, i) => (
              <div
                key={i}
                className={
                  m.role === "guest"
                    ? "ml-auto max-w-[85%] whitespace-pre-line rounded-xl rounded-tr-none bg-pool p-3 text-sm text-white shadow-sm"
                    : "max-w-[85%] whitespace-pre-line rounded-xl rounded-tl-none bg-white p-3 text-sm text-ink shadow-sm"
                }
              >
                {linkify(m.text)}
              </div>
            ))}
            {busy && (
              <div className="max-w-[85%] rounded-xl rounded-tl-none bg-white p-3 text-sm text-ink-soft shadow-sm">
                Typing…
              </div>
            )}
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
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Type a message…"
              aria-label="Your message"
              maxLength={1000}
              className="min-w-0 flex-1 rounded-full bg-stone-100 px-4 py-2.5 text-sm text-ink outline-none placeholder:text-ink-soft"
            />
            <button
              type="submit"
              aria-label="Send message"
              disabled={busy}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-pool text-white transition-transform hover:scale-105 disabled:opacity-50"
            >
              <SendHorizontal size={18} />
            </button>
          </form>
        </div>
      )}

      <button
        type="button"
        onClick={() => {
          if (!open) track("chat_open");
          setOpen(!open);
        }}
        aria-label={open ? "Close chat" : "Chat with us"}
        className="flex h-14 w-14 items-center justify-center rounded-full bg-pool text-white shadow-lg transition-transform hover:scale-110"
      >
        <MessageCircle size={26} />
      </button>
    </div>
  );
}
