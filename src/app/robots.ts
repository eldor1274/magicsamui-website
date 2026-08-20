import type { MetadataRoute } from "next";
import { site } from "@/data/site";

// Everyone is welcome to crawl the public site — including AI crawlers, which
// GA4 shows are already a top-converting traffic source. The named AI agents
// are listed explicitly so a future blanket rule can never lock them out by
// accident. Only machine endpoints and the private admin screen are off-limits.

const AI_CRAWLERS = [
  "GPTBot", // ChatGPT training + search
  "OAI-SearchBot", // ChatGPT search
  "ChatGPT-User", // ChatGPT live browsing for a user
  "ClaudeBot", // Anthropic crawler
  "Claude-User", // Claude live browsing for a user
  "PerplexityBot",
  "Perplexity-User",
  "Google-Extended", // Gemini training
  "Applebot-Extended", // Apple Intelligence
  "meta-externalagent", // Meta AI
  "Amazonbot", // Alexa
  "CCBot", // Common Crawl, feeds many models
  "DuckAssistBot",
];

export default function robots(): MetadataRoute.Robots {
  const disallow = ["/api/", "/points/admin"];
  return {
    rules: [
      { userAgent: "*", allow: "/", disallow },
      ...AI_CRAWLERS.map((userAgent) => ({ userAgent, allow: "/", disallow })),
    ],
    sitemap: `https://${site.domain}/sitemap.xml`,
  };
}
