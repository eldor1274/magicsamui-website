// Renders schema.org structured data. JSON.stringify output is safe to
// inline as long as the data contains no user-generated content.
export default function JsonLd({ data }: { data: object }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  );
}
