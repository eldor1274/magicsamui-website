import Link from "next/link";

export default function BookNowButton({
  className = "",
  children = "Book Now",
}: {
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <Link
      href="/booking"
      className={`inline-flex items-center justify-center rounded-full bg-pool px-6 py-3 text-sm font-medium tracking-wide text-white transition-colors hover:bg-pool-dark ${className}`}
    >
      {children}
    </Link>
  );
}
