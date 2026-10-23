import Link from "next/link";
import type { BlogBlock, BlogLinkItem } from "@/data/blog";

function ListItem({ item }: { item: string | BlogLinkItem }) {
  if (typeof item === "string") return <>{item}</>;
  const className = "font-medium text-pool hover:underline";
  return (
    <>
      {/^https?:\/\//.test(item.href) ? (
        // WhatsApp and other outside links: a plain anchor, as in the footer.
        <a href={item.href} className={className}>
          {item.label}
        </a>
      ) : (
        <Link href={item.href} className={className}>
          {item.label}
        </Link>
      )}
      {item.text ? ` — ${item.text}` : null}
    </>
  );
}

export default function BlogContent({ blocks }: { blocks: BlogBlock[] }) {
  return (
    <div className="space-y-5">
      {blocks.map((block, i) => {
        switch (block.type) {
          case "h2":
            return (
              <h2 key={i} className="pt-4 font-serif text-2xl text-ink">
                {block.text}
              </h2>
            );
          case "h3":
            return (
              <h3 key={i} className="pt-2 font-serif text-xl text-ink">
                {block.text}
              </h3>
            );
          case "h4":
            return (
              <h4 key={i} className="font-medium text-ink">
                {block.text}
              </h4>
            );
          case "ul":
            return (
              <ul key={i} className="list-disc space-y-1 pl-5 text-ink-soft">
                {block.items?.map((item, j) => (
                  <li key={j}>
                    <ListItem item={item} />
                  </li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={i} className="list-decimal space-y-1 pl-5 text-ink-soft">
                {block.items?.map((item, j) => (
                  <li key={j}>
                    <ListItem item={item} />
                  </li>
                ))}
              </ol>
            );
          case "quote":
            return (
              <blockquote key={i} className="border-l-2 border-pool pl-4 italic text-ink-soft">
                {block.text}
              </blockquote>
            );
          default:
            return (
              <p key={i} className="leading-relaxed text-ink-soft">
                {block.text}
              </p>
            );
        }
      })}
    </div>
  );
}
