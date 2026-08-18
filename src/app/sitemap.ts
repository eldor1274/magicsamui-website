import type { MetadataRoute } from "next";
import { rooms } from "@/data/rooms";
import { getAllBlogPosts } from "@/data/blog";
import { site } from "@/data/site";

export default function sitemap(): MetadataRoute.Sitemap {
  const base = `https://${site.domain}`;

  const staticRoutes = [
    "",
    "/rooms",
    "/rentals",
    "/guide",
    "/blog",
    "/about",
    "/contact",
    "/privacy",
  ].map((route) => ({
    url: `${base}${route}`,
    lastModified: new Date(),
  }));

  const roomRoutes = rooms.map((room) => ({
    url: `${base}/rooms/${room.slug}`,
    lastModified: new Date(),
  }));

  const blogRoutes = getAllBlogPosts().map((post) => ({
    url: `${base}/blog/${post.slug}`,
    lastModified: new Date(),
  }));

  return [...staticRoutes, ...roomRoutes, ...blogRoutes];
}
