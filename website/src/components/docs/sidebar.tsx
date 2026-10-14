import { Link } from "@tanstack/react-router";
import { groupBySection, type NavPage } from "@/lib/docs-nav";
import { cn } from "@/lib/utils";

export function DocsSidebar({ pages, current }: { pages: NavPage[]; current: string }) {
  const groups = groupBySection(pages);
  return (
    <nav aria-label="Documentation" className="space-y-7 text-sm">
      {groups.map((g) => (
        <div key={g.section}>
          <h2 className="px-3 text-[0.8125rem] font-semibold text-bone">{g.section}</h2>
          <ul className="mt-2 space-y-0.5 border-l border-cobble">
            {g.pages.map((p) => {
              const active = p.slug === current;
              return (
                <li key={p.slug}>
                  <Link
                    to="/docs/$slug/"
                    params={{ slug: p.slug }}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "-ml-px block border-l-2 py-1.5 pr-2 pl-3 transition-colors",
                      active ? "border-grass font-medium text-grass-bright" : "border-transparent text-fog hover:border-cobble-2 hover:text-bone",
                    )}
                  >
                    {p.title}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
