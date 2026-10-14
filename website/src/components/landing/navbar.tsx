import { lazy, Suspense, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Menu, Search } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { searchDialog, shortcutLabel, useSearchDialogOpen, useSearchShortcut } from "@/hooks/use-search-dialog";
import { RELEASES_URL, REPO_URL, VERSION } from "@/lib/site";
import { cn } from "@/lib/utils";
import { GitHubMark, Wordmark } from "./logo";

const SearchDialog = lazy(() => import("@/components/docs/search-dialog"));

const navLink = "rounded-sm px-1 py-1 text-sm whitespace-nowrap text-fog transition-colors hover:text-bone";

/** Sticky site header shared by the landing and the docs. `mobileExtra` goes into the mobile menu (the docs pages). */
export function Navbar({ mobileExtra, wide = false }: { mobileExtra?: ReactNode; wide?: boolean }) {
  useSearchShortcut();
  const searchOpen = useSearchDialogOpen();
  // The dialog's chunk (with the docs index) is only fetched the first time someone searches.
  const [searchUsed, setSearchUsed] = useState(false);
  if (searchOpen && !searchUsed) setSearchUsed(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = () => setMenuOpen(false);

  return (
    <header className="sticky top-0 z-40 border-b border-white/[0.06] bg-deepslate/80 backdrop-blur-md supports-[backdrop-filter]:bg-deepslate/65">
      <div className={cn("mx-auto flex h-16 items-center gap-6 px-4 sm:px-6 lg:px-8", wide ? "max-w-[1400px]" : "max-w-[1240px]")}>
        <Link to="/" className="rounded-sm" aria-label="MC Server Manager, home">
          <Wordmark />
        </Link>

        <nav aria-label="Main" className="hidden items-center gap-5 md:flex">
          <Link to="/" hash="features" className={navLink}>Features</Link>
          <Link to="/" hash="how-it-works" className={navLink}>How it works</Link>
          <Link to="/docs/$slug/" params={{ slug: "introduction" }} className={navLink} activeProps={{ className: "text-bone" }} activeOptions={{ includeHash: false }}>
            Docs
          </Link>
        </nav>

        <div className="ml-auto flex items-center gap-2 sm:gap-3">
          <button
            type="button"
            onClick={() => searchDialog.open()}
            className="hidden h-9 items-center gap-2 rounded-md border border-cobble bg-bedrock/70 pr-1.5 pl-3 text-sm text-fog transition-colors hover:border-cobble-2 hover:text-bone lg:inline-flex"
          >
            <Search className="size-4" aria-hidden="true" />
            <span className="pr-6">Search docs</span>
            <kbd className="kbd" aria-hidden="true">{shortcutLabel()}</kbd>
          </button>
          <button
            type="button"
            onClick={() => searchDialog.open()}
            className="inline-flex size-9 items-center justify-center rounded-md text-fog transition-colors hover:text-bone lg:hidden"
            aria-label="Search docs"
          >
            <Search className="size-5" aria-hidden="true" />
          </button>
          <a
            href={RELEASES_URL}
            className="notch hidden bg-torch/12 px-2 py-1 font-mono text-xs font-medium text-torch transition-colors hover:bg-torch/20 sm:inline-block md:hidden lg:inline-block"
            style={{ ["--notch" as string]: "2px" }}
            title="Release notes"
          >
            v{VERSION}
          </a>
          <a href={REPO_URL} className="hidden size-9 items-center justify-center rounded-md text-fog transition-colors hover:text-bone md:inline-flex" aria-label="MC Server Manager on GitHub">
            <GitHubMark />
          </a>
          <Link to="/docs/$slug/" params={{ slug: "installation" }} className="btn-block btn-sm hidden md:inline-flex">
            Get started
          </Link>

          <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
            <SheetTrigger asChild>
              {/* With docs navigation in it, the menu is needed until the docs sidebar appears (lg). */}
              <button
                type="button"
                className={cn("inline-flex size-9 items-center justify-center rounded-md text-bone", mobileExtra ? "lg:hidden" : "md:hidden")}
                aria-label="Open the menu"
              >
                <Menu className="size-5" aria-hidden="true" />
              </button>
            </SheetTrigger>
            <SheetContent side="right" className="w-[min(20rem,88vw)] gap-0 overflow-y-auto border-cobble bg-deepslate p-0">
              <SheetTitle className="px-5 pt-5 pb-3">
                <Wordmark />
              </SheetTitle>
              <SheetDescription className="sr-only">Site navigation</SheetDescription>
              <nav aria-label="Main" className="flex flex-col px-3 pb-2">
                <Link to="/" hash="features" onClick={closeMenu} className="rounded-md px-2 py-2.5 text-[0.9375rem] text-bone hover:bg-accent">Features</Link>
                <Link to="/" hash="how-it-works" onClick={closeMenu} className="rounded-md px-2 py-2.5 text-[0.9375rem] text-bone hover:bg-accent">How it works</Link>
                <Link to="/docs/$slug/" params={{ slug: "introduction" }} onClick={closeMenu} className="rounded-md px-2 py-2.5 text-[0.9375rem] text-bone hover:bg-accent">Docs</Link>
                <a href={REPO_URL} className="flex items-center gap-2 rounded-md px-2 py-2.5 text-[0.9375rem] text-bone hover:bg-accent">
                  GitHub
                </a>
                <a href={RELEASES_URL} className="rounded-md px-2 py-2.5 text-[0.9375rem] text-bone hover:bg-accent">
                  Releases <span className="font-mono text-sm text-torch">v{VERSION}</span>
                </a>
              </nav>
              <div className="px-5 pb-4">
                <Link to="/docs/$slug/" params={{ slug: "installation" }} onClick={closeMenu} className="btn-block w-full">
                  Get started
                </Link>
              </div>
              {mobileExtra && <div className="border-t border-cobble px-3 pt-4 pb-6" onClickCapture={(e) => (e.target as HTMLElement).closest("a") && closeMenu()}>{mobileExtra}</div>}
            </SheetContent>
          </Sheet>
        </div>
      </div>
      {searchUsed && (
        <Suspense fallback={null}>
          <SearchDialog open={searchOpen} onOpenChange={searchDialog.set} />
        </Suspense>
      )}
    </header>
  );
}
