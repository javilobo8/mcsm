import { useEffect, useMemo } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { Pencil, Search } from "lucide-react";
import { pages } from "virtual:docs";
import { DocContent } from "@/components/docs/doc-content";
import { PrevNext } from "@/components/docs/prev-next";
import { DocsSidebar } from "@/components/docs/sidebar";
import { DocsToc } from "@/components/docs/toc";
import { Footer } from "@/components/landing/footer";
import { Navbar } from "@/components/landing/navbar";
import { SkipLink } from "@/components/landing/skip-link";
import { searchDialog, shortcutLabel } from "@/hooks/use-search-dialog";
import { useScrollSpy } from "@/hooks/use-scroll-spy";
import { docTitle } from "@/lib/doc-title";
import { neighbours } from "@/lib/docs-nav";
import { editUrl } from "@/lib/site";

export function DocsPage() {
  const { slug } = useParams({ from: "/docs/$slug" });
  const page = pages.find((p) => p.slug === slug);
  const { prev, next } = neighbours(pages, slug);
  const ids = useMemo(() => page?.toc.map((t) => t.id) ?? [], [page]);
  const active = useScrollSpy(ids);

  useEffect(() => {
    document.title = docTitle(page ? page.title : "Page not found");
  }, [page]);

  const sidebar = <DocsSidebar pages={pages} current={slug} />;

  return (
    <div className="flex min-h-dvh flex-col">
      <SkipLink />
      <Navbar wide mobileExtra={sidebar} />
      <div className="mx-auto w-full max-w-[1400px] flex-1 px-4 sm:px-6 lg:grid lg:grid-cols-[14.5rem_minmax(0,1fr)] lg:gap-10 lg:px-8 xl:grid-cols-[14.5rem_minmax(0,1fr)_13rem] xl:gap-14">
        <aside className="hidden lg:block">
          <div className="sticky top-16 max-h-[calc(100dvh-4rem)] overflow-y-auto pt-10 pb-12">
            <button
              type="button"
              onClick={() => searchDialog.open()}
              className="mb-7 flex h-9 w-full items-center gap-2 rounded-md border border-cobble bg-bedrock/70 pr-1.5 pl-3 text-sm text-fog transition-colors hover:border-cobble-2 hover:text-bone"
            >
              <Search className="size-4" aria-hidden="true" />
              <span className="flex-1 text-left">Search</span>
              <kbd className="kbd" aria-hidden="true">{shortcutLabel()}</kbd>
            </button>
            {sidebar}
          </div>
        </aside>

        <main id="main" className="min-w-0 pt-8 pb-16 lg:pt-12">
          <div className="mx-auto max-w-[46rem]">
            {page ? (
              <article>
                <header className="mb-10 border-b border-cobble pb-8">
                  <h1 className="font-pixel text-[2.25rem] leading-[1.1] font-semibold text-bone sm:text-[2.75rem]">{page.title}</h1>
                  <p className="mt-4 text-lg leading-relaxed text-fog">{page.description}</p>
                </header>
                <DocContent key={page.slug} html={page.html} slug={page.slug} />
                <footer className="mt-14 space-y-8 border-t border-cobble pt-8">
                  <a href={editUrl(page.slug)} className="inline-flex items-center gap-2 text-sm text-fog transition-colors hover:text-bone">
                    <Pencil className="size-4" aria-hidden="true" />
                    Edit this page on GitHub
                  </a>
                  <PrevNext prev={prev} next={next} />
                </footer>
              </article>
            ) : (
              <DocsNotFound slug={slug} />
            )}
          </div>
        </main>

        <aside className="hidden xl:block">
          <div className="sticky top-16 max-h-[calc(100dvh-4rem)] overflow-y-auto pt-12 pb-12">
            {page && <DocsToc slug={page.slug} toc={page.toc} active={active} />}
          </div>
        </aside>
      </div>
      <Footer wide />
    </div>
  );
}

function DocsNotFound({ slug }: { slug: string }) {
  return (
    <div className="py-10">
      <h1 className="font-pixel text-[2.25rem] leading-tight font-semibold text-bone">Page not found</h1>
      <p className="mt-4 max-w-prose text-lg leading-relaxed text-fog">
        There is no documentation page called “{slug}”. It may have moved: search the docs or start from the introduction.
      </p>
      <div className="mt-8 flex flex-wrap gap-3">
        <Link to="/docs/$slug/" params={{ slug: "introduction" }} className="btn-block">
          Go to the introduction
        </Link>
        <button type="button" onClick={() => searchDialog.open()} className="btn-block btn-stone">
          <Search aria-hidden="true" />
          Search the docs
        </button>
      </div>
    </div>
  );
}
