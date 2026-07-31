import fs from "node:fs";
import path from "node:path";

export interface BlogBlock {
  type: "h2" | "h3" | "h4" | "p" | "ul" | "ol" | "quote";
  text?: string;
  items?: string[];
}

export interface BlogPost {
  slug: string;
  title: string;
  description: string;
  heroImage: string | null;
  blocks: BlogBlock[];
}

const BLOG_DIR = path.join(process.cwd(), "src/data/blog-posts");

function localHeroImage(slug: string, remoteUrl: string | null): string | null {
  if (!remoteUrl) return null;
  const ext = path.extname(remoteUrl.split("?")[0]) || ".jpg";
  return `/images/blog/${slug}${ext}`;
}

export function getAllBlogPosts(): BlogPost[] {
  const files = fs.readdirSync(BLOG_DIR).filter((f) => f.endsWith(".json"));
  return files
    .map((file) => {
      const raw = fs.readFileSync(path.join(BLOG_DIR, file), "utf-8");
      const data = JSON.parse(raw);
      return {
        ...data,
        heroImage: localHeroImage(data.slug, data.heroImage),
      } as BlogPost;
    })
    .sort((a, b) => a.title.localeCompare(b.title));
}

export function getBlogPostBySlug(slug: string): BlogPost | undefined {
  const filePath = path.join(BLOG_DIR, `${slug}.json`);
  if (!fs.existsSync(filePath)) return undefined;
  const raw = fs.readFileSync(filePath, "utf-8");
  const data = JSON.parse(raw);
  return {
    ...data,
    heroImage: localHeroImage(data.slug, data.heroImage),
  } as BlogPost;
}
