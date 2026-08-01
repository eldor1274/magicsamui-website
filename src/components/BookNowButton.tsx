"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { track } from "@/lib/track";

export default function BookNowButton({
  className = "",
  children = "Book Now",
}: {
  className?: string;
  children?: React.ReactNode;
}) {
  const pathname = usePathname();

  return (
    <Link
      href="/booking"
      onClick={() => track("book_now_click", { from_page: pathname })}
      className={`inline-flex items-center justify-center rounded-full bg-pool px-6 py-3 text-sm font-medium tracking-wide text-white transition-colors hover:bg-pool-dark ${className}`}
    >
      {children}
    </Link>
  );
}
