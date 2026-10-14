import { useParams } from "@tanstack/react-router";
import { pages } from "virtual:docs";

export function DocsPage() {
  const { slug } = useParams({ from: "/docs/$slug" });
  const page = pages.find((p) => p.slug === slug);
  return (
    <main className="mx-auto max-w-5xl px-4 py-24">
      <h1 className="font-pixel text-4xl">{page?.title ?? slug}</h1>
      {page && <div dangerouslySetInnerHTML={{ __html: page.html }} />}
    </main>
  );
}
