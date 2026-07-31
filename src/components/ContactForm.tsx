"use client";

import { useState, type FormEvent } from "react";
import { site } from "@/data/site";

export default function ContactForm() {
  const [name, setName] = useState("");
  const [contact, setContact] = useState("");
  const [message, setMessage] = useState("");

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const subject = encodeURIComponent(`Inquiry from ${name || "website visitor"}`);
    const body = encodeURIComponent(
      `Name: ${name}\nPhone/Email: ${contact}\n\n${message}`
    );
    window.location.href = `mailto:${site.email}?subject=${subject}&body=${body}`;
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-ink" htmlFor="name">
          Name
        </label>
        <input
          id="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          className="mt-1 w-full rounded-lg border border-stone-100 bg-white px-4 py-2.5 text-ink outline-none ring-pool/40 focus:ring-2"
        />
      </div>
      <div>
        <label className="block text-sm font-medium text-ink" htmlFor="contact">
          Phone or Email
        </label>
        <input
          id="contact"
          value={contact}
          onChange={(e) => setContact(e.target.value)}
          required
          className="mt-1 w-full rounded-lg border border-stone-100 bg-white px-4 py-2.5 text-ink outline-none ring-pool/40 focus:ring-2"
        />
      </div>
      <div>
        <label className="block text-sm font-medium text-ink" htmlFor="message">
          Message
        </label>
        <textarea
          id="message"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          required
          rows={5}
          className="mt-1 w-full rounded-lg border border-stone-100 bg-white px-4 py-2.5 text-ink outline-none ring-pool/40 focus:ring-2"
        />
      </div>
      <button
        type="submit"
        className="w-full rounded-full bg-pool px-6 py-3 text-sm font-medium text-white hover:bg-pool-dark"
      >
        Send
      </button>
    </form>
  );
}
