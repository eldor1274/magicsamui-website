import type { MetadataRoute } from "next";
import { rooms } from "@/data/rooms";
import { getAllBlogPosts } from "@/data/blog";
import { site } from "@/data/site";

export default function sitemap(): MetadataRoute.Sitemap {
  const base = `https://${site.domain}`;

  // /booking and /points are real, indexable, guest-facing pages that llms.txt
  // already points crawlers at — only /points/admin is disallowed in robots.ts.
  const staticRoutes = [
    "",
    "/booking",
    "/rooms",
    "/rentals",
    "/points",
    "/guide",
    "/blog",
    "/about",
    "/contact",
    "/privacy",
    "/security",
    "/he",
    "/ru",
    "/fr",
    "/de",
    "/zh",
    "/es",
    "/th",
  ].map((route) => ({ url: `${base}${route}` }));

  const roomRoutes = rooms.map((room) => ({ url: `${base}/rooms/${room.slug}` }));

  const blogRoutes = getAllBlogPosts().map((post) => ({
    url: `${base}/blog/${post.slug}`,
    lastModified: post.dateModified,
  }));

  return [...staticRoutes, ...roomRoutes, ...blogRoutes];
}
