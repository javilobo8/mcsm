import { Link } from "@tanstack/react-router";

export function NotFoundPage() {
  return (
    <main className="mx-auto max-w-5xl px-4 py-24">
      <h1 className="font-pixel text-4xl">Page not found</h1>
      <p className="mt-4 text-fog">There is nothing at this address.</p>
      <Link to="/" className="mt-6 inline-block text-grass underline underline-offset-4">Go to the home page</Link>
    </main>
  );
}
