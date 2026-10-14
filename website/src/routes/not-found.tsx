import { useEffect } from "react";
import { Link } from "@tanstack/react-router";
import { Footer } from "@/components/landing/footer";
import { Navbar } from "@/components/landing/navbar";
import { SkipLink } from "@/components/landing/skip-link";
import { SITE_NAME } from "@/lib/site";

export function NotFoundPage() {
  useEffect(() => {
    document.title = `Page not found · ${SITE_NAME}`;
  }, []);
  return (
    <div className="flex min-h-dvh flex-col">
      <SkipLink />
      <Navbar />
      <main id="main" className="mx-auto w-full max-w-[1240px] flex-1 px-4 py-24 sm:px-6 lg:px-8">
        <p className="font-pixel text-6xl text-cobble-2" aria-hidden="true">404</p>
        <h1 className="mt-4 font-pixel text-4xl font-semibold text-bone">Page not found</h1>
        <p className="mt-4 max-w-prose text-lg text-fog">Nothing lives at this address. Head back to the home page or open the documentation.</p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link to="/" className="btn-block">Go to the home page</Link>
          <Link to="/docs/$slug/" params={{ slug: "introduction" }} className="btn-block btn-stone">Read the docs</Link>
        </div>
      </main>
      <Footer />
    </div>
  );
}
