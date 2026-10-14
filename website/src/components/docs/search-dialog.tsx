import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Command as CommandPrimitive } from "cmdk";
import { FileText, Hash, Search } from "lucide-react";
import { pages } from "virtual:docs";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { groupBySection } from "@/lib/docs-nav";
import { buildSearchIndex, search, type SearchEntry } from "@/lib/search";

const index = buildSearchIndex(pages);

const entryKey = (e: { slug: string; anchor?: string }) => `${e.slug}#${e.anchor ?? ""}`;

/** The ⌘K dialog over page titles, descriptions and h2/h3 headings (lazy: it carries the docs index). */
export default function SearchDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [query, setQuery] = useState("");
  const navigate = useNavigate();
  const blank = query.trim() === "";
  const results = useMemo(() => search(index, query), [query]);

  const go = (e: { slug: string; anchor?: string }) => {
    onOpenChange(false);
    void navigate({ to: "/docs/$slug/", params: { slug: e.slug }, hash: e.anchor });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) setQuery("");
        onOpenChange(next);
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="top-[10vh] translate-y-0 grid-cols-[minmax(0,1fr)] gap-0 overflow-hidden border-cobble-2 bg-bedrock p-0 sm:max-w-xl"
      >
        <DialogTitle className="sr-only">Search the documentation</DialogTitle>
        <DialogDescription className="sr-only">Type to search page titles and headings, then press Enter to open the result.</DialogDescription>
        <CommandPrimitive shouldFilter={false} loop className="flex flex-col">
          <div className="flex items-center gap-3 border-b border-cobble px-4">
            <Search className="size-4 shrink-0 text-fog" aria-hidden="true" />
            <CommandPrimitive.Input
              value={query}
              onValueChange={setQuery}
              placeholder="Search the docs"
              className="h-13 w-full bg-transparent text-[0.9375rem] text-bone outline-none placeholder:text-fog"
            />
            <kbd className="kbd hidden sm:inline-flex">Esc</kbd>
          </div>
          <CommandPrimitive.List className="max-h-[min(60vh,26rem)] scroll-py-2 overflow-y-auto p-2">
            <CommandPrimitive.Empty className="px-3 py-8 text-center text-sm text-fog">
              {pages.length === 0 ? "The documentation has no pages yet." : `Nothing matches “${query.trim()}”. Try fewer or shorter words.`}
            </CommandPrimitive.Empty>
            {blank
              ? groupBySection(pages).map((g) => (
                  <CommandPrimitive.Group key={g.section} heading={g.section} className="search-group">
                    {g.pages.map((p) => (
                      <ResultItem key={p.slug} value={entryKey(p)} onSelect={() => go(p)} title={p.title} detail={p.description} heading={false} />
                    ))}
                  </CommandPrimitive.Group>
                ))
              : results.map((e: SearchEntry) => (
                  <ResultItem
                    key={entryKey(e)}
                    value={entryKey(e)}
                    onSelect={() => go(e)}
                    title={e.title}
                    detail={e.anchor ? `In ${e.page}` : e.text}
                    heading={e.anchor !== undefined}
                  />
                ))}
          </CommandPrimitive.List>
          <div className="flex items-center gap-4 border-t border-cobble px-4 py-2.5 text-xs text-fog">
            <span className="inline-flex items-center gap-1.5"><kbd className="kbd">↑</kbd><kbd className="kbd">↓</kbd> to move</span>
            <span className="inline-flex items-center gap-1.5"><kbd className="kbd">Enter</kbd> to open</span>
          </div>
        </CommandPrimitive>
      </DialogContent>
    </Dialog>
  );
}

function ResultItem({ value, onSelect, title, detail, heading }: { value: string; onSelect: () => void; title: string; detail: string; heading: boolean }) {
  const Icon = heading ? Hash : FileText;
  return (
    <CommandPrimitive.Item
      value={value}
      onSelect={onSelect}
      className="group flex cursor-pointer items-start gap-3 rounded-md px-3 py-2.5 text-sm outline-none data-[selected=true]:bg-accent"
    >
      <Icon className="mt-0.5 size-4 shrink-0 text-fog group-data-[selected=true]:text-grass" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-bone">{title}</span>
        <span className="block truncate text-[0.8125rem] text-fog">{detail}</span>
      </span>
    </CommandPrimitive.Item>
  );
}
