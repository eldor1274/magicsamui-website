import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { getAllBlogPosts } from "@/data/blog";

export const metadata: Metadata = {
  title: "Blog | Magic Suites & Villas",
  description: "Guides and tips for planning your stay in Koh Samui, from Magic Suites & Villas.",
};

export default function BlogIndexPage() {
  const posts = getAllBlogPosts();

  return (
    <div className="mx-auto max-w-6xl px-5 py-16">
      <p className="text-sm uppercase tracking-[0.3em] text-pool">From Magic Suites</p>
      <h1 className="mt-3 font-serif text-4xl text-ink">Koh Samui Travel Guides</h1>
      <p className="mt-4 max-w-2xl text-ink-soft">
        Tips, guides and inspiration for planning your stay on the island.
      </p>

      <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {posts.map((post) => (
          <Link
            key={post.slug}
            href={`/blog/${post.slug}`}
            className="group flex flex-col overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-black/5 transition-shadow hover:shadow-lg"
          >
            {post.heroImage && (
              <div className="relative aspect-[4/3] w-full overflow-hidden">
                <Image
                  src={post.heroImage}
                  alt={post.title}
                  fill
                  sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw"
                  className="object-cover transition-transform duration-500 group-hover:scale-105"
                />
              </div>
            )}
            <div className="flex flex-1 flex-col gap-2 p-5">
              <h2 className="font-serif text-lg leading-snug text-ink">{post.title}</h2>
              <p className="text-sm text-ink-soft line-clamp-3">{post.description}</p>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
