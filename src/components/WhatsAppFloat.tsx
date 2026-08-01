import { site } from "@/data/site";

// Floating chat bubble on every page; the WhatsApp number is answered
// instantly by the support bot.
export default function WhatsAppFloat() {
  return (
    <a
      href={`${site.whatsapp}?text=${encodeURIComponent("Hi Magic Suites & Villas! I have a question.")}`}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Chat with us on WhatsApp"
      className="fixed bottom-5 right-5 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-[#25D366] text-white shadow-lg transition-transform hover:scale-110"
    >
      <svg viewBox="0 0 32 32" width="30" height="30" fill="currentColor" aria-hidden="true">
        <path d="M16 3C9.4 3 4 8.3 4 14.9c0 2.6.8 5 2.3 7L4.7 27.6a1 1 0 0 0 1.2 1.3l6-1.6a12.2 12.2 0 0 0 4.1.7c6.6 0 12-5.3 12-11.9S22.6 3 16 3Zm0 21.8c-1.3 0-2.6-.3-3.7-.7l-.7-.3-3.6 1 1-3.4-.5-.7a9.7 9.7 0 0 1-1.9-5.8c0-5.4 4.2-9.7 9.4-9.7s9.4 4.3 9.4 9.7-4.2 9.9-9.4 9.9Zm5.2-7.2c-.3-.2-1.7-.9-2-1-.3-.1-.5-.2-.7.1-.2.3-.8 1-.9 1.2-.2.2-.3.2-.6.1a7.7 7.7 0 0 1-3.9-3.4c-.3-.5.3-.5.8-1.6.1-.2 0-.4 0-.6l-.9-2.2c-.2-.6-.5-.5-.7-.5h-.6c-.2 0-.5.1-.8.4-.3.3-1 1-1 2.5s1.1 2.9 1.2 3.1c.2.2 2.1 3.2 5.1 4.5.7.3 1.3.5 1.7.6.7.2 1.4.2 1.9.1.6-.1 1.7-.7 2-1.4.2-.7.2-1.3.2-1.4-.1-.1-.3-.2-.6-.4Z" />
      </svg>
      <span className="sr-only">Chat with us on WhatsApp</span>
    </a>
  );
}
