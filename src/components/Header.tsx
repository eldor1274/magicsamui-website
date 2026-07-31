"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Menu, X, Phone } from "lucide-react";
import { nav, site } from "@/data/site";
import BookNowButton from "./BookNowButton";

export default function Header() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-50 border-b border-stone-100 bg-stone-50/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-4">
        <Link href="/" className="font-serif text-xl tracking-wide text-ink">
          Magic Suites <span className="text-pool">&amp; Villas</span>
        </Link>

        <nav className="hidden items-center gap-8 lg:flex">
          {nav.map((item) => {
            const active = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`text-sm tracking-wide transition-colors hover:text-pool ${
                  active ? "text-pool" : "text-ink-soft"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="hidden items-center gap-4 lg:flex">
          <a
            href={`tel:${site.phones[0].tel}`}
            className="flex items-center gap-2 text-sm text-ink-soft hover:text-pool"
          >
            <Phone size={16} />
            {site.phones[0].number}
          </a>
          <BookNowButton />
        </div>

        <button
          aria-label="Toggle menu"
          className="text-ink lg:hidden"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? <X size={26} /> : <Menu size={26} />}
        </button>
      </div>

      {open && (
        <div className="border-t border-stone-100 bg-stone-50 px-5 pb-6 lg:hidden">
          <nav className="flex flex-col gap-4 pt-4">
            {nav.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
                className="text-base text-ink-soft hover:text-pool"
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="mt-5 flex flex-col gap-3">
            <a href={`tel:${site.phones[0].tel}`} className="text-sm text-ink-soft">
              {site.phones[0].number}
            </a>
            <BookNowButton className="w-full" />
          </div>
        </div>
      )}
    </header>
  );
}
