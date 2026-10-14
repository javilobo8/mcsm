import { Link } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { NavPage } from "@/lib/docs-nav";

export function PrevNext({ prev, next }: { prev?: NavPage; next?: NavPage }) {
  if (!prev && !next) return null;
  const card = "group flex flex-col gap-1 rounded-md border border-cobble px-4 py-3 transition-colors hover:border-grass/60 hover:bg-bedrock";
  return (
    <nav aria-label="Previous and next page" className="grid gap-3 sm:grid-cols-2">
      {prev ? (
        <Link to="/docs/$slug/" params={{ slug: prev.slug }} className={card}>
          <span className="flex items-center gap-1 text-xs text-fog"><ChevronLeft className="size-3.5" aria-hidden="true" />Previous</span>
          <span className="font-medium text-bone group-hover:text-grass-bright">{prev.title}</span>
        </Link>
      ) : (
        <span className="hidden sm:block" />
      )}
      {next && (
        <Link to="/docs/$slug/" params={{ slug: next.slug }} className={`${card} sm:items-end sm:text-right`}>
          <span className="flex items-center gap-1 text-xs text-fog">Next<ChevronRight className="size-3.5" aria-hidden="true" /></span>
          <span className="font-medium text-bone group-hover:text-grass-bright">{next.title}</span>
        </Link>
      )}
    </nav>
  );
}
