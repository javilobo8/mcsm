import { useEffect } from "react";
import { Footer } from "@/components/landing/footer";
import { Navbar } from "@/components/landing/navbar";
import { SkipLink } from "@/components/landing/skip-link";
import { SITE_NAME } from "@/lib/site";

export function HomePage() {
  useEffect(() => {
    document.title = SITE_NAME;
  }, []);
  return (
    <div className="flex min-h-dvh flex-col">
      <SkipLink />
      <Navbar />
      <main id="main" className="mx-auto w-full max-w-[1240px] flex-1 px-4 py-24 sm:px-6 lg:px-8">
        <h1 className="font-pixel text-5xl">MC Server Manager</h1>
      </main>
      <Footer />
    </div>
  );
}
