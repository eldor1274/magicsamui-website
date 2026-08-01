import type { Metadata } from "next";
import Image from "next/image";
import { notFound } from "next/navigation";
import BlogContent from "@/components/BlogContent";
import BlogCta from "@/components/BlogCta";
import { getAllBlogPosts, getBlogPostBySlug } from "@/data/blog";

export function generateStaticParams() {
  return getAllBlogPosts().map((post) => ({ slug: post.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const post = getBlogPostBySlug(slug);
  if (!post) return {};
  return {
    title: `${post.title} | Magic Suites & Villas`,
    description: post.description,
    alternates: { canonical: `/blog/${post.slug}` },
    openGraph: {
      title: post.title,
      description: post.description,
      ...(post.heroImage
        ? { images: [{ url: post.heroImage, width: 1200, height: 630, alt: post.title }] }
        : {}),
    },
  };
}

export default async function BlogPostPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const post = getBlogPostBySlug(slug);
  if (!post) notFound();

  return (
    <article className="mx-auto max-w-3xl px-5 py-16">
      <h1 className="font-serif text-3xl leading-tight text-ink sm:text-4xl">{post.title}</h1>
      {post.description && <p className="mt-4 text-lg text-ink-soft">{post.description}</p>}

      {post.heroImage && (
        <div className="relative mt-8 aspect-[16/10] w-full overflow-hidden rounded-2xl">
          <Image
            src={post.heroImage}
            alt={post.title}
            fill
            priority
            sizes="(min-width: 1024px) 768px, 100vw"
            className="object-cover"
          />
        </div>
      )}

      <div className="mt-8">
        <BlogContent blocks={post.blocks} />
      </div>

      <BlogCta />
    </article>
  );
}
