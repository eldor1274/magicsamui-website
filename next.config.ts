import type { NextConfig } from "next";
import { readdirSync } from "fs";
import { join } from "path";

// The WordPress site served blog posts at the root (magicsamui.com/<slug>)
// and rooms under long descriptive slugs; Google still has ~1,300 of those
// old URLs. 301s preserve their ranking value on the new structure.
const blogSlugs = readdirSync(join(process.cwd(), "src/data/blog-posts"))
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.replace(/\.json$/, ""));

const oldRoomSlugs: [string, string][] = [
  ["design-modern-2-bedroom-villa-tuxedo", "tuxedo"],
  ["garden-suite-1-bedroom", "garden-suite"],
  ["honeymoon-seaview-private-pool-suite", "honeymoon-suite"],
  ["island-views-sunrise-jet-plunge-pool-private-suite", "island-view-3br"],
  ["magic-seaview-jet-plunge-pool-private-suite-2br", "seaview-2br"],
  ["magic-view-jet-plunge-pool-private-suite", "seaview-suite"],
];

const nextConfig: NextConfig = {
  images: {
    qualities: [60, 75],
  },
  async redirects() {
    return [
      ...blogSlugs.map((slug) => ({
        source: `/${slug}`,
        destination: `/blog/${slug}`,
        permanent: true,
      })),
      ...oldRoomSlugs.map(([oldSlug, newSlug]) => ({
        source: `/rooms/${oldSlug}`,
        destination: `/rooms/${newSlug}`,
        permanent: true,
      })),
      { source: "/contact-us", destination: "/contact", permanent: true },
      { source: "/motorbike-car-rentals", destination: "/rentals", permanent: true },
      { source: "/apartments", destination: "/rooms", permanent: true },
      { source: "/blog/page/:page", destination: "/blog", permanent: true },
      { source: "/author/:path*", destination: "/blog", permanent: true },
      { source: "/category/:path*", destination: "/blog", permanent: true },
      { source: "/tag/:path*", destination: "/blog", permanent: true },
      { source: "/events", destination: "/guide", permanent: true },
      { source: "/check-out", destination: "/booking", permanent: true },
      { source: "/2024/:path*", destination: "/blog", permanent: true },
      { source: "/2025/:path*", destination: "/blog", permanent: true },
    ];
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
