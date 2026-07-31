import { site } from "@/data/site";

export default function BookNowButton({
  className = "",
  children = "Book Now",
}: {
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <a
      href={site.cloudbedsReservationUrl}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex items-center justify-center rounded-full bg-pool px-6 py-3 text-sm font-medium tracking-wide text-white transition-colors hover:bg-pool-dark ${className}`}
    >
      {children}
    </a>
  );
}
