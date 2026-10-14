import { useParams } from "@tanstack/react-router";

export function DocsPage() {
  const { slug } = useParams({ from: "/docs/$slug" });
  return (
    <main className="mx-auto max-w-5xl px-4 py-24">
      <h1 className="font-pixel text-4xl">{slug}</h1>
    </main>
  );
}
