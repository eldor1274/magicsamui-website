import type { Metadata } from "next";
import { Phone, MessageCircle, Mail, MapPin } from "lucide-react";
import ContactForm from "@/components/ContactForm";
import { InstagramIcon, FacebookIcon, TikTokIcon } from "@/components/SocialIcons";
import { site } from "@/data/site";

export const metadata: Metadata = {
  title: "Contact Us | Magic Suites & Villas",
  description: "Get in touch with Magic Suites & Villas, Koh Samui.",
};

export default function ContactPage() {
  return (
    <div className="mx-auto max-w-5xl px-5 py-16">
      <p className="text-sm uppercase tracking-[0.3em] text-pool">Get in touch</p>
      <h1 className="mt-3 font-serif text-4xl text-ink">Contact Magic Suites &amp; Villas</h1>

      <div className="mt-10 grid gap-12 lg:grid-cols-2">
        <div>
          <div className="space-y-4">
            <a href={site.whatsapp} className="flex items-center gap-3 rounded-xl bg-stone-100 p-4 hover:bg-sand-light/40">
              <MessageCircle className="text-pool" size={20} />
              <div>
                <p className="font-medium text-ink">WhatsApp</p>
                <p className="text-sm text-ink-soft">Fastest way to reach us</p>
              </div>
            </a>
            <a href={site.line} className="flex items-center gap-3 rounded-xl bg-stone-100 p-4 hover:bg-sand-light/40">
              <MessageCircle className="text-pool" size={20} />
              <div>
                <p className="font-medium text-ink">LINE</p>
                <p className="text-sm text-ink-soft">@Eldor1274</p>
              </div>
            </a>
            <a
              href={site.instagram}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 rounded-xl bg-stone-100 p-4 hover:bg-sand-light/40"
            >
              <span className="text-pool">
                <InstagramIcon size={20} />
              </span>
              <div>
                <p className="font-medium text-ink">Instagram</p>
                <p className="text-sm text-ink-soft">@magic1samui</p>
              </div>
            </a>
            <a
              href={site.facebook}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 rounded-xl bg-stone-100 p-4 hover:bg-sand-light/40"
            >
              <span className="text-pool">
                <FacebookIcon size={20} />
              </span>
              <div>
                <p className="font-medium text-ink">Facebook</p>
                <p className="text-sm text-ink-soft">Magicsamui Villas&amp;Suites</p>
              </div>
            </a>
            <a
              href={site.tiktok}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 rounded-xl bg-stone-100 p-4 hover:bg-sand-light/40"
            >
              <span className="text-pool">
                <TikTokIcon size={20} />
              </span>
              <div>
                <p className="font-medium text-ink">TikTok</p>
                <p className="text-sm text-ink-soft">@magic.suites</p>
              </div>
            </a>
            {site.phones.map((p) => (
              <a key={p.tel} href={`tel:${p.tel}`} className="flex items-center gap-3 rounded-xl bg-stone-100 p-4 hover:bg-sand-light/40">
                <Phone className="text-pool" size={20} />
                <div>
                  <p className="font-medium text-ink">{p.number}</p>
                  <p className="text-sm text-ink-soft">{p.label}</p>
                </div>
              </a>
            ))}
            <a href={`mailto:${site.email}`} className="flex items-center gap-3 rounded-xl bg-stone-100 p-4 hover:bg-sand-light/40">
              <Mail className="text-pool" size={20} />
              <div>
                <p className="font-medium text-ink">{site.email}</p>
                <p className="text-sm text-ink-soft">Email</p>
              </div>
            </a>
            <a href={site.mapsUrl} className="flex items-center gap-3 rounded-xl bg-stone-100 p-4 hover:bg-sand-light/40">
              <MapPin className="text-pool" size={20} />
              <div>
                <p className="font-medium text-ink">{site.address}</p>
                <p className="text-sm text-ink-soft">Get directions</p>
              </div>
            </a>
          </div>
        </div>

        <div>
          <h2 className="font-serif text-xl text-ink">Send us a message</h2>
          <p className="mt-2 text-sm text-ink-soft">
            Sent directly to {site.email} — no email app needed.
          </p>
          <div className="mt-5">
            <ContactForm />
          </div>
        </div>
      </div>
    </div>
  );
}
