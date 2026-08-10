import Image from "next/image";
import Link from "next/link";
import type { BlogPost } from "@/data/blog";

export default function RelatedPosts({ posts }: { posts: BlogPost[] }) {
  if (posts.length === 0) return null;
  return (
    <section className="mt-12 border-t border-stone-100 pt-10">
      <h2 className="font-serif text-2xl text-ink">Keep Reading</h2>
      <div className="mt-6 grid gap-6 sm:grid-cols-3">
        {posts.map((post) => (
          <Link
            key={post.slug}
            href={`/blog/${post.slug}`}
            className="group flex flex-col overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-black/5 transition-shadow hover:shadow-lg"
          >
            {post.heroImage && (
              <div className="relative aspect-[16/10] w-full overflow-hidden">
                <Image
                  src={post.heroImage}
                  alt={post.title}
                  fill
                  sizes="(min-width: 640px) 33vw, 100vw"
                  className="object-cover transition-transform duration-500 group-hover:scale-105"
                />
              </div>
            )}
            <div className="flex flex-1 flex-col gap-1 p-4">
              <h3 className="font-serif text-base leading-snug text-ink">{post.title}</h3>
              <p className="text-sm text-ink-soft line-clamp-2">{post.description}</p>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}
