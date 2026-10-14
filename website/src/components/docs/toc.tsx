import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/utils";

export function DocsToc({ slug, toc, active }: { slug: string; toc: { depth: 2 | 3; id: string; text: string }[]; active: string | undefined }) {
  if (toc.length === 0) return null;
  return (
    <nav aria-labelledby="toc-title" className="text-[0.8125rem]">
      <h2 id="toc-title" className="font-semibold text-bone">On this page</h2>
      <ul className="mt-3 space-y-1 border-l border-cobble">
        {toc.map((t) => (
          <li key={t.id}>
            <Link
              to="/docs/$slug/"
              params={{ slug }}
              hash={t.id}
              resetScroll={false}
              aria-current={active === t.id ? "location" : undefined}
              className={cn(
                "-ml-px block border-l-2 py-1 leading-snug transition-colors",
                t.depth === 3 ? "pl-6" : "pl-3",
                active === t.id ? "border-grass text-bone" : "border-transparent text-fog hover:text-bone",
              )}
            >
              {t.text}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
