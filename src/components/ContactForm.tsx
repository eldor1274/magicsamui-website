"use client";

import { useState, type FormEvent } from "react";
import { track } from "@/lib/track";
import { isValidContact } from "@/lib/validateContact";

export default function ContactForm() {
  const [name, setName] = useState("");
  const [contact, setContact] = useState("");
  const [message, setMessage] = useState("");
  // honeypot — humans never see this field; bots auto-fill it
  const [company, setCompany] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [contactError, setContactError] = useState("");

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();

    if (!isValidContact(contact)) {
      setContactError("Enter a valid email, or a phone number with country code (e.g. +66...)");
      return;
    }
    setContactError("");

    setStatus("sending");
    try {
      const res = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, contact, message, company }),
      });
      if (!res.ok) throw new Error();
      setStatus("sent");
      track("contact_form_submit");
      setName("");
      setContact("");
      setMessage("");
    } catch {
      setStatus("error");
    }
  }

  if (status === "sent") {
    return (
      <div className="rounded-lg bg-stone-100 p-5 text-ink-soft">
        Thanks — your message has been sent. We&apos;ll get back to you soon.
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4" noValidate>
      <div aria-hidden="true" className="absolute -left-[9999px] top-auto h-px w-px overflow-hidden">
        <label htmlFor="company">Company (leave this empty)</label>
        <input
          id="company"
          name="company"
          value={company}
          onChange={(e) => setCompany(e.target.value)}
          tabIndex={-1}
          autoComplete="off"
        />
      </div>
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
          Phone (with country code) or Email
        </label>
        <input
          id="contact"
          value={contact}
          onChange={(e) => {
            setContact(e.target.value);
            if (contactError) setContactError("");
          }}
          placeholder="+66 95 246 6011 or you@example.com"
          required
          className="mt-1 w-full rounded-lg border border-stone-100 bg-white px-4 py-2.5 text-ink outline-none ring-pool/40 focus:ring-2"
        />
        {contactError && <p className="mt-1 text-sm text-red-600">{contactError}</p>}
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
      {status === "error" && (
        <p className="text-sm text-red-600">
          Something went wrong sending your message — please try WhatsApp or phone instead.
        </p>
      )}
      <button
        type="submit"
        disabled={status === "sending"}
        className="w-full rounded-full bg-pool px-6 py-3 text-sm font-medium text-white hover:bg-pool-dark disabled:opacity-60"
      >
        {status === "sending" ? "Sending..." : "Send"}
      </button>
    </form>
  );
}
