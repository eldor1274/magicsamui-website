import Link from "next/link";
import { MessageCircle, Phone, Mail, MapPin } from "lucide-react";
import { InstagramIcon, FacebookIcon, TikTokIcon } from "@/components/SocialIcons";
import { nav, site } from "@/data/site";

export default function Footer() {
  return (
    <footer className="border-t border-stone-100 bg-stone-100 text-ink-soft">
      <div className="mx-auto grid max-w-6xl gap-10 px-5 py-14 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <p className="font-serif text-lg text-ink">Magic Suites &amp; Villas</p>
          <p className="mt-3 text-sm leading-relaxed">{site.tagline}</p>
          <div className="mt-4 flex items-start gap-2 text-sm">
            <MapPin size={16} className="mt-0.5 shrink-0" />
            <a href={site.mapsUrl} className="hover:text-pool">
              {site.address}
            </a>
          </div>
        </div>

        <div>
          <p className="text-sm font-medium text-ink">Explore</p>
          <ul className="mt-3 space-y-2 text-sm">
            {nav.map((item) => (
              <li key={item.href}>
                <Link href={item.href} className="hover:text-pool">
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <p className="text-sm font-medium text-ink">Contact</p>
          <ul className="mt-3 space-y-2 text-sm">
            {site.phones.map((p) => (
              <li key={p.tel}>
                <a href={`tel:${p.tel}`} className="flex items-center gap-2 hover:text-pool">
                  <Phone size={14} /> {p.number}
                  <span className="text-xs text-ink-soft">({p.label})</span>
                </a>
              </li>
            ))}
            <li>
              <a href={`mailto:${site.email}`} className="flex items-center gap-2 hover:text-pool">
                <Mail size={14} /> {site.email}
              </a>
            </li>
          </ul>
        </div>

        <div>
          <p className="text-sm font-medium text-ink">Message us</p>
          <ul className="mt-3 space-y-2 text-sm">
            <li>
              <a href={site.whatsapp} className="flex items-center gap-2 hover:text-pool">
                <MessageCircle size={14} /> WhatsApp
              </a>
            </li>
            <li>
              <a href={site.line} className="flex items-center gap-2 hover:text-pool">
                <MessageCircle size={14} /> LINE
              </a>
            </li>
            <li>
              <a
                href={site.instagram}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 hover:text-pool"
              >
                <InstagramIcon size={14} /> Instagram
              </a>
            </li>
            <li>
              <a
                href={site.facebook}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 hover:text-pool"
              >
                <FacebookIcon size={14} /> Facebook
              </a>
            </li>
            <li>
              <a
                href={site.tiktok}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 hover:text-pool"
              >
                <TikTokIcon size={14} /> TikTok
              </a>
            </li>
          </ul>
        </div>
      </div>

      <div className="border-t border-stone-100/80 px-5 py-6 text-center text-xs text-ink-soft">
        <p>
          &copy; {new Date().getFullYear()} {site.name} ·{" "}
          <Link href="/legal" className="hover:text-pool">
            Legal
          </Link>
        </p>
      </div>
    </footer>
  );
}
