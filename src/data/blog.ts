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

// Words too generic to signal topical relatedness between posts.
const STOP_WORDS = new Set([
  "koh", "samui", "in", "for", "the", "a", "to", "of", "and", "your",
  "how", "what", "where", "best", "guide", "villa", "villas",
]);

function slugKeywords(slug: string): Set<string> {
  return new Set(slug.split("-").filter((w) => w.length > 2 && !STOP_WORDS.has(w)));
}

/**
 * Related posts by shared slug keywords ("villa" and "koh samui" excluded
 * as they appear everywhere). Falls back to alphabetical neighbours so
 * every post always links to three others — the internal-link mesh is
 * what lets Google discover and rank these pages.
 */
export function getRelatedPosts(slug: string, count = 3): BlogPost[] {
  const everyone = getAllBlogPosts();
  const myIdx = everyone.findIndex((p) => p.slug === slug);
  const n = everyone.length;
  const mine = slugKeywords(slug);
  const scored = everyone
    .map((p, idx) => {
      let score = 0;
      for (const w of slugKeywords(p.slug)) if (mine.has(w)) score++;
      // Tiebreak: alphabetical successors of THIS post (wrapping), so
      // zero-match posts each link to different neighbours and every
      // post in the mesh receives incoming links.
      const distance = (idx - myIdx + n) % n;
      return { p, score, distance };
    })
    .filter(({ p }) => p.slug !== slug)
    .sort((a, b) => b.score - a.score || a.distance - b.distance);
  return scored.slice(0, count).map((s) => s.p);
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
