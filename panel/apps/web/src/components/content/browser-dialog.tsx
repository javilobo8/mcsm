import { Fragment, useEffect, useMemo, useReducer, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, Download, ExternalLink, LoaderCircle, PackageSearch, Search, X } from "lucide-react";
import {
  CONTENT_SORTS, listFor,
  type ContentHit, type ContentListKey, type ContentLoader, type ContentPlatform, type ContentSearchQuery, type ContentSort,
  type ContentTarget, type PackInfoDto, type ResolveResultDto,
} from "@mcsm/shared";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { StatusBadge } from "@/components/status";
import { CurseForgeKeyNotice } from "@/components/spec-form/curseforge-key";
import { ApiError } from "@/lib/api";
import { dialogSubmit } from "@/lib/dialog-form";
import {
  browserReducer, defaultVersionId, formatDownloads, hitStatus, initialBrowserState, installedRefs, kindLabel, packContents, platformLabel,
  searchQuery, SEARCH_LIMIT, type BrowserAction, type BrowserState, type Selected,
} from "@/lib/content-browser";
import { addSummary, applyResolved, crossPlatformWarnings } from "@/lib/content-deps";
import { presentFor } from "@/lib/content-lists";
import { withPackInstalled } from "@/lib/content-pack";
import { browserTabs, browseTarget, CURSEFORGE_PLUGINS, type BrowserTab } from "@/lib/content-target";
import { typeLabel } from "@/lib/spec-catalog";
import { withVersion, type EditableSpec } from "@/lib/spec-edit";
import { cn } from "@/lib/utils";
import {
  fetchContentVersions, packQuery, resolveContent, useContentCategories, useContentLookup, useContentProject, useContentSearch,
  useContentVersions, useCurseForgeConfigured, type VersionFilter,
} from "@/hooks/use-content";
import { useVersions } from "@/hooks/use-versions";
import { ContentImage } from "./content-image";
import { Description } from "./description";

export interface ContentBrowserProps {
  open: boolean;
  onOpenChange(o: boolean): void;
  spec: EditableSpec;
  /** The installed pack's details (modpack servers): its loader/version drive the search and its contents show "In modpack". */
  pack: PackInfoDto | null;
  /** "new-server": only the Modpacks tabs, any Minecraft version by default. */
  mode: "server" | "new-server";
  initialTab?: BrowserTab;
  onApply(next: EditableSpec): void;
}

const SORT_LABEL: Record<ContentSort, string> = { relevance: "Relevance", downloads: "Most downloaded", newest: "Newest", updated: "Recently updated" };
const CF_SERVER_NOTE = "CurseForge does not say whether a mod runs on servers: client-only mods may stop the server from starting.";
const WORLD_VERSION_NOTE = "Changing the Minecraft version of a world can break it";
const MAX_SELECTIONS = 50;
const NEW_SERVER_TABS: BrowserTab[] = [{ platform: "modrinth", kind: "modpack" }, { platform: "curseforge", kind: "modpack" }];

const tabValue = (t: BrowserTab) => `${t.platform}:${t.kind}`;
const errorText = (e: unknown) => (e instanceof Error ? e.message : "Unexpected error");

/** Near-full-screen browser of Modrinth and CurseForge (layout "A"): filters, results, detail; "Add to server" edits the form. */
export function ContentBrowserDialog(props: ContentBrowserProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="flex h-[90vh] max-w-[calc(100%-1rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(96vw,1400px)]" data-testid="content-browser">
        {/* Mounted only while open: every opening starts from a clean search. */}
        {props.open && <Browser {...props} />}
      </DialogContent>
    </Dialog>
  );
}

type Review = { kind: "content"; result: ResolveResultDto; warnings: string[] } | { kind: "pack"; info: PackInfoDto };

function Browser({ spec, pack, mode, initialTab, onApply, onOpenChange }: ContentBrowserProps) {
  const qc = useQueryClient();
  const tabs = mode === "new-server" ? NEW_SERVER_TABS : browserTabs(spec.type, { curseforgePlugins: CURSEFORGE_PLUGINS });
  const firstTab = (initialTab && tabs.find((t) => tabValue(t) === tabValue(initialTab))) ?? tabs[0]!;
  const [s, dispatch] = useReducer(browserReducer, firstTab, (t) => initialBrowserState(t, { anyVersion: mode === "new-server" }));
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clientOnly, setClientOnly] = useState<ReadonlySet<string>>(new Set());

  // Any change to what is selected invalidates a prepared review.
  const act = (a: BrowserAction) => {
    if (a.type === "tab" || a.type === "toggle" || a.type === "version" || a.type === "clear") { setReview(null); setError(null); }
    dispatch(a);
  };

  const { platform, kind } = s.tab;
  const bt = browseTarget(spec, kind, pack);
  const target = bt.ok ? bt.target : null;
  const cfConfigured = useCurseForgeConfigured();
  const cfMissing = platform === "curseforge" && cfConfigured === false;
  const list = kind === "modpack" ? null : listFor(platform, kind);
  const installed = useMemo(() => installedRefs(spec, platform), [spec, platform]);
  const inPack = useMemo(() => packContents(pack, platform), [pack, platform]);
  const versionFilter: VersionFilter = {
    kind, loaders: target?.loaders ?? [],
    ...((kind === "modpack" && s.anyVersion) || !target?.gameVersion ? {} : { gameVersion: target.gameVersion }),
  };
  const otherPlatform: ContentPlatform = platform === "modrinth" ? "curseforge" : "modrinth";
  const others = useContentLookup(mode === "server" && list ? presentFor(spec, otherPlatform) : []);
  const selected = [...s.selected.values()];

  const pickVersion = async (it: Selected) => {
    if (it.versionId) return it.versionId;
    const { versions } = await fetchContentVersions(qc, platform, it.projectId, versionFilter);
    const v = defaultVersionId(versions, null);
    if (!v) throw new Error(`${it.name} has no version that can be installed on this server`);
    return v;
  };

  const prepare = async () => {
    setBusy(true); setError(null);
    try {
      if (selected.length > MAX_SELECTIONS) throw new Error(`Select at most ${MAX_SELECTIONS} projects at a time`);
      if (kind === "modpack") {
        const it = selected[0]!;
        const info = await qc.fetchQuery(packQuery({ platform, projectId: it.projectId, versionId: await pickVersion(it) }));
        setReview({ kind: "pack", info });
      } else if (list && target) {
        const selections = await Promise.all(selected.map(async (it) => ({ projectId: it.projectId, versionId: await pickVersion(it) })));
        const result = await resolveContent({
          list, selections, present: presentFor(spec, platform),
          target: { gameVersion: target.gameVersion, loaders: target.loaders as ContentLoader[] },
          pack: pack && pack.platform === platform ? { platform: pack.platform, projectId: pack.projectId, versionId: pack.versionId } : null,
        });
        setReview({ kind: "content", result, warnings: crossPlatformWarnings(selected, others.data ?? []) });
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const confirm = () => {
    if (!review) return;
    onApply(review.kind === "pack" ? withPackInstalled(spec, review.info) : applyResolved(spec, review.result));
    onOpenChange(false);
  };

  const markClientOnly = (id: string) => {
    setClientOnly((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
    if (s.selected.has(id)) act({ type: "toggle", item: s.selected.get(id)! });
  };

  const context = mode === "new-server"
    ? s.anyVersion ? "Any Minecraft version" : "Packs for the chosen Minecraft version"
    : target
      ? `${pack && kind !== "modpack" ? pack.name : typeLabel(spec.type)}${target.gameVersion ? ` · Minecraft ${target.gameVersion}` : ""}${kind === "modpack" && s.anyVersion ? " · any Minecraft version" : ""}`
      : `${typeLabel(spec.type)} · ${spec.version}`;

  return (
    <>
      <BrowserHeader title={mode === "new-server" ? "Start from a modpack" : "Browse content"} context={context} tabs={tabs} state={s} act={act} />
      <div className="flex min-h-0 flex-1">
        <Filters state={s} act={act} target={target} cfMissing={cfMissing} className="hidden w-56 shrink-0 border-r border-cobble lg:flex" />
        <section aria-label="Results" className={cn("min-w-0 flex-1 flex-col", s.detail ? "hidden lg:flex" : "flex")}>
          <Filters state={s} act={act} target={target} cfMissing={cfMissing} compact className="flex border-b border-cobble lg:hidden" />
          {cfMissing ? (
            <Blocked icon={<PackageSearch />} title="CurseForge needs an API key">
              <p>The panel queries CurseForge with your key; it never reaches the browser.</p>
              <div className="mt-3 text-left"><CurseForgeKeyNotice /></div>
            </Blocked>
          ) : !bt.ok ? (
            <NotBrowsable reason={bt.reason} pinTo={bt.pinTo} spec={spec} onApply={onApply} />
          ) : (
            <ResultList key={JSON.stringify({ ...searchQuery(s, target), offset: 0 })} state={s} act={act} target={target!} installed={installed} inPack={inPack} clientOnly={clientOnly} />
          )}
        </section>
        <section aria-label="Details" className={cn("min-w-0 flex-col border-cobble lg:w-[26rem] lg:shrink-0 lg:border-l xl:w-[30rem]", s.detail ? "flex flex-1 lg:flex-none" : "hidden lg:flex")}>
          {s.detail ? (
            <Detail key={`${platform}:${s.detail}`} platform={platform} kind={kind} projectId={s.detail} list={list} selected={s.selected.get(s.detail) ?? null}
              filter={versionFilter} installed={installed} inPack={inPack} act={act} onClientOnly={markClientOnly} />
          ) : (
            <Blocked icon={<PackageSearch />} title="Nothing open">Choose a project to see its description, versions and dependencies.</Blocked>
          )}
        </section>
      </div>
      <BrowserFooter selected={selected} act={act} review={review} busy={busy} error={error} mode={mode} spec={spec}
        onPrepare={() => void prepare()} onConfirm={confirm} onBack={() => setReview(null)} onCancel={() => onOpenChange(false)} />
    </>
  );
}

function BrowserHeader({ title, context, tabs, state, act }: { title: string; context: string; tabs: BrowserTab[]; state: BrowserState; act: (a: BrowserAction) => void }) {
  const [text, setText] = useState(state.q);
  // Debounce: search 300 ms after the last keystroke (Enter searches at once).
  useEffect(() => {
    if (text === state.q) return;
    const t = setTimeout(() => act({ type: "query", q: text }), 300);
    return () => clearTimeout(t);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps -- only typing restarts the timer
  const platforms = [...new Set(tabs.map((t) => t.platform))];
  return (
    <header className="flex flex-col gap-3 border-b border-cobble px-4 pt-4 pb-3 pr-12">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <DialogTitle className="font-pixel text-xl font-semibold text-bone">{title}</DialogTitle>
        <DialogDescription className="text-xs">{context}</DialogDescription>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Tabs value={tabValue(state.tab)} onValueChange={(v) => act({ type: "tab", tab: tabs.find((t) => tabValue(t) === v)! })}>
          <TabsList variant="pill" className="w-auto max-w-full overflow-x-auto [scrollbar-width:none] sm:flex-wrap sm:gap-y-1" aria-label="Source and kind">
            {platforms.map((p, i) => (
              <Fragment key={p}>
                <span aria-hidden="true" className={cn("px-1.5 text-xs font-medium text-muted-foreground", i > 0 && "ml-2 border-l border-cobble pl-3")}>{platformLabel(p)}</span>
                {tabs.filter((t) => t.platform === p).map((t) => (
                  <TabsTrigger key={tabValue(t)} value={tabValue(t)} aria-label={`${platformLabel(p)} ${kindLabel(t.kind).toLowerCase()}`}>{kindLabel(t.kind)}</TabsTrigger>
                ))}
              </Fragment>
            ))}
          </TabsList>
        </Tabs>
        <form role="search" className="relative w-full sm:ml-auto sm:w-80" onSubmit={dialogSubmit(() => act({ type: "query", q: text }))}>
          <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input type="search" value={text} onChange={(e) => setText(e.target.value)} maxLength={100} className="pl-8"
            placeholder={`Search ${kindLabel(state.tab.kind).toLowerCase()} on ${platformLabel(state.tab.platform)}`} aria-label="Search" />
        </form>
      </div>
    </header>
  );
}

function Filters({ state, act, target, cfMissing, compact, className }: {
  state: BrowserState; act: (a: BrowserAction) => void; target: ContentTarget | null; cfMissing: boolean; compact?: boolean; className?: string;
}) {
  const categories = useContentCategories(state.tab.platform, state.tab.kind, target !== null && !cfMissing);
  const id = compact ? "cb-m" : "cb";
  const sort = (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`${id}-sort`} className="text-xs text-muted-foreground">Sort by</Label>
      <Select value={state.sort} onValueChange={(v) => act({ type: "sort", sort: v as ContentSort })}>
        <SelectTrigger id={`${id}-sort`} size="sm" className="w-full"><SelectValue /></SelectTrigger>
        <SelectContent>{CONTENT_SORTS.map((o) => <SelectItem key={o} value={o}>{SORT_LABEL[o]}</SelectItem>)}</SelectContent>
      </Select>
    </div>
  );
  const anyVersion = state.tab.kind === "modpack" && (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <Checkbox id={`${id}-any`} checked={state.anyVersion} onCheckedChange={(v) => act({ type: "anyVersion", on: v === true })} />
        <Label htmlFor={`${id}-any`} className="text-sm font-normal">Any Minecraft version</Label>
      </div>
      {state.anyVersion && <p className="text-xs text-warn">{WORLD_VERSION_NOTE}</p>}
    </div>
  );
  if (compact) {
    return (
      <div className={cn("flex-wrap items-end gap-3 px-3 py-2", className)}>
        <div className="w-40">{sort}</div>
        {(categories.data?.length ?? 0) > 0 && (
          <div className="flex w-44 flex-col gap-1.5">
            <Label htmlFor={`${id}-cat`} className="text-xs text-muted-foreground">Category</Label>
            <Select value={state.category ?? "__all"} onValueChange={(v) => act({ type: "category", category: v === "__all" ? null : v })}>
              <SelectTrigger id={`${id}-cat`} size="sm" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__all">All categories</SelectItem>
                {categories.data!.map((c) => <SelectItem key={c.id} value={c.id}>{c.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        )}
        {anyVersion}
      </div>
    );
  }
  return (
    <aside aria-label="Filters" className={cn("flex-col gap-5 overflow-y-auto p-3", className)}>
      {sort}
      {anyVersion}
      <nav aria-label="Categories" className="flex flex-col gap-1">
        <h3 className="mb-1 text-xs text-muted-foreground">Categories</h3>
        {categories.isPending && target !== null && !cfMissing
          ? Array.from({ length: 8 }, (_, i) => <span key={i} className="h-7 animate-pulse rounded-sm bg-bedrock-2" />)
          : categories.isError
            ? <p className="text-xs text-warn">Categories are not available right now.</p>
            : [{ id: null, label: "All categories" }, ...(categories.data ?? [])].map((c) => (
              <button key={c.id ?? "__all"} type="button" aria-pressed={state.category === c.id} onClick={() => act({ type: "category", category: c.id })}
                className={cn("rounded-sm px-2 py-1 text-left text-sm text-fog transition-colors hover:bg-accent hover:text-bone aria-pressed:bg-grass/10 aria-pressed:text-ok")}>
                {c.label}
              </button>
            ))}
      </nav>
    </aside>
  );
}

function ResultList({ state, act, target, installed, inPack, clientOnly }: {
  state: BrowserState; act: (a: BrowserAction) => void; target: ContentTarget; installed: ReadonlySet<string>; inPack: ReadonlySet<string>; clientOnly: ReadonlySet<string>;
}) {
  const base = searchQuery(state, target)!;
  const first = useContentSearch(state.tab.platform, { ...base, offset: 0 });
  const offsets: number[] = [];
  for (let o = 0; o <= state.offset; o += SEARCH_LIMIT) offsets.push(o);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <p className="flex items-center gap-2 px-4 py-2 text-xs text-muted-foreground" aria-live="polite">
        {first.data ? `${first.data.total.toLocaleString("en")} ${first.data.total === 1 ? "result" : "results"}` : first.isPending ? "Searching…" : " "}
        {first.data?.stale && <span className="text-warn">· the source is not responding: showing saved results</span>}
      </p>
      <ul className="min-h-0 flex-1 overflow-y-auto border-t border-cobble/60" aria-label="Search results">
        {offsets.map((o) => (
          <ResultPage key={o} platform={state.tab.platform} query={{ ...base, offset: o }} last={o === state.offset} state={state} act={act}
            installed={installed} inPack={inPack} clientOnly={clientOnly} />
        ))}
      </ul>
    </div>
  );
}

function ResultPage({ platform, query, last, state, act, installed, inPack, clientOnly }: {
  platform: ContentPlatform; query: ContentSearchQuery; last: boolean; state: BrowserState; act: (a: BrowserAction) => void;
  installed: ReadonlySet<string>; inPack: ReadonlySet<string>; clientOnly: ReadonlySet<string>;
}) {
  const r = useContentSearch(platform, query);
  if (r.isPending) return <>{Array.from({ length: query.offset === 0 ? 7 : 3 }, (_, i) => <RowSkeleton key={i} />)}</>;
  if (r.isError) {
    return (
      <li className="p-4">
        <p role="alert" className="text-sm text-bad">{errorText(r.error)}</p>
        <Button type="button" size="sm" variant="secondary" className="mt-2" onClick={() => void r.refetch()}>Try again</Button>
      </li>
    );
  }
  const { hits, total, offset, limit } = r.data;
  if (offset === 0 && hits.length === 0) {
    return (
      <li>
        <Blocked icon={<Search />} title="No results">
          {query.q ? `Nothing matches “${query.q}”` : "Nothing found"}{query.category ? " in this category" : ""} for this server. Try other words or another category.
        </Blocked>
      </li>
    );
  }
  const list = state.tab.kind === "modpack" ? null : listFor(platform, state.tab.kind);
  return (
    <>
      {hits.map((hit) => (
        <ResultRow key={hit.projectId} hit={hit} list={list} open={state.detail === hit.projectId} selected={state.selected.get(hit.projectId)}
          status={hitStatus(hit, installed, inPack)} clientOnly={clientOnly.has(hit.projectId)} act={act} />
      ))}
      {last && offset + limit < total && (
        <li className="flex justify-center p-3">
          <Button type="button" variant="outline" size="sm" onClick={() => act({ type: "page", offset: offset + SEARCH_LIMIT })}>Load more</Button>
        </li>
      )}
    </>
  );
}

function RowSkeleton() {
  return (
    <li className="flex items-start gap-3 border-b border-cobble/60 px-3 py-3" aria-hidden="true">
      <span className="mt-3 size-4 rounded-[3px] bg-bedrock-2" />
      <span className="size-10 animate-pulse rounded-md bg-bedrock-2" />
      <span className="flex flex-1 flex-col gap-2 pt-0.5">
        <span className="h-3.5 w-1/3 animate-pulse rounded-sm bg-bedrock-2" />
        <span className="h-3 w-5/6 animate-pulse rounded-sm bg-bedrock-2" />
        <span className="h-3 w-16 animate-pulse rounded-sm bg-bedrock-2" />
      </span>
    </li>
  );
}

/** ↑/↓ move between result rows. */
function moveFocus(e: React.KeyboardEvent<HTMLButtonElement>) {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  const rows = [...(e.currentTarget.closest("ul")?.querySelectorAll<HTMLElement>("[data-row]") ?? [])];
  const next = rows[rows.indexOf(e.currentTarget) + (e.key === "ArrowDown" ? 1 : -1)];
  if (next) { e.preventDefault(); next.focus(); }
}

function ResultRow({ hit, list, open, selected, status, clientOnly, act }: {
  hit: ContentHit; list: ContentListKey | null; open: boolean; selected: Selected | undefined; status: "installed" | "in-modpack" | null;
  clientOnly: boolean; act: (a: BrowserAction) => void;
}) {
  const disabled = clientOnly || status === "in-modpack";
  const why = clientOnly ? "Client-only: it does not run on servers" : status === "in-modpack" ? "The modpack already brings it" : undefined;
  return (
    <li className={cn("flex items-start gap-3 border-b border-cobble/60 px-3 py-2.5 transition-colors", open ? "bg-bedrock-2" : selected ? "bg-grass/[0.05]" : "hover:bg-bedrock/60")}>
      <Checkbox className="mt-3" checked={selected !== undefined} disabled={disabled} title={why} aria-label={`Select ${hit.name}`}
        onCheckedChange={() => act({ type: "toggle", item: { projectId: hit.projectId, versionId: "", name: hit.name, slug: hit.slug, list } })} />
      <button type="button" data-row aria-current={open || undefined} onClick={() => act({ type: "open", projectId: hit.projectId })} onKeyDown={moveFocus}
        className="flex min-w-0 flex-1 items-start gap-3 rounded-sm text-left outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        <ContentImage src={hit.iconUrl} alt="" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="truncate font-medium text-bone">{hit.name}</span>
            {hit.author && <span className="truncate text-xs text-muted-foreground">by {hit.author}</span>}
          </span>
          <span className="line-clamp-2 text-xs leading-relaxed text-fog">{hit.summary}</span>
          <span className="mt-0.5 inline-flex items-center gap-1 text-xs text-muted-foreground tabular-nums">
            <Download className="size-3" aria-hidden="true" />
            <span><span className="sr-only">Downloads: </span>{formatDownloads(hit.downloads)}</span>
          </span>
        </span>
      </button>
      {status && <StatusBadge tone={status === "installed" ? "ok" : "info"} className="mt-0.5">{status === "installed" ? "Installed" : "In modpack"}</StatusBadge>}
    </li>
  );
}

function Detail({ platform, kind, projectId, list, selected, filter, installed, inPack, act, onClientOnly }: {
  platform: ContentPlatform; kind: BrowserTab["kind"]; projectId: string; list: ContentListKey | null; selected: Selected | null; filter: VersionFilter;
  installed: ReadonlySet<string>; inPack: ReadonlySet<string>; act: (a: BrowserAction) => void; onClientOnly: (id: string) => void;
}) {
  const project = useContentProject(platform, projectId);
  const versions = useContentVersions(platform, projectId, filter);
  const [chosen, setChosen] = useState<string | null>(null);
  const all = versions.data?.versions ?? [];
  const versionId = selected?.versionId || chosen || defaultVersionId(all, null);
  const version = all.find((v) => v.versionId === versionId) ?? null;
  const deps = (version?.dependencies ?? []).filter((d) => d.projectId && d.type !== "embedded");
  const names = useContentLookup(list ? deps.map((d) => ({ list, entry: d.projectId! })) : []);
  const nameOf = (id: string) => names.data?.find((m) => m.projectId === id || m.raw === id)?.name ?? id;
  const p = project.data;
  useEffect(() => { if (p?.clientOnly) onClientOnly(projectId); }, [p?.clientOnly, projectId]); // eslint-disable-line react-hooks/exhaustive-deps -- report once per project

  const back = (
    <Button type="button" variant="ghost" size="sm" className="self-start lg:hidden" onClick={() => act({ type: "open", projectId: null })}>
      <ArrowLeft /> Back to results
    </Button>
  );
  if (project.isPending) {
    return (
      <div className="flex flex-col gap-4 p-4" aria-busy="true">
        {back}
        <div className="flex gap-3"><span className="size-16 animate-pulse rounded-md bg-bedrock-2" /><span className="flex flex-1 flex-col gap-2 pt-1"><span className="h-5 w-1/2 animate-pulse rounded-sm bg-bedrock-2" /><span className="h-3 w-1/3 animate-pulse rounded-sm bg-bedrock-2" /></span></div>
        <span className="h-9 animate-pulse rounded-md bg-bedrock-2" />
        {Array.from({ length: 6 }, (_, i) => <span key={i} className="h-3 animate-pulse rounded-sm bg-bedrock-2" style={{ width: `${90 - i * 7}%` }} />)}
      </div>
    );
  }
  if (project.isError) {
    const notFound = project.error instanceof ApiError && project.error.status === 404;
    return (
      <div className="flex flex-col p-4">
        {back}
        <Blocked icon={<PackageSearch />} title={notFound ? "Not found" : "Could not load this project"}>
          <span className={notFound ? undefined : "text-bad"}>{project.error.message}</span>
        </Blocked>
      </div>
    );
  }
  const status = hitStatus(p!, installed, inPack);
  const noVersion = versions.isSuccess && !all.some((v) => v.installable);
  const canSelect = !p!.clientOnly && status !== "in-modpack" && !noVersion && version?.installable !== false;
  const pick = (id: string) => { setChosen(id); act({ type: "version", projectId, versionId: id }); };
  const toggle = () => act({ type: "toggle", item: { projectId, versionId: versionId ?? "", name: p!.name, slug: p!.slug, list } });

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex flex-col gap-4 p-4">
        {back}
        <div className="flex gap-3">
          <ContentImage src={p!.iconUrl} alt="" size="lg" />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h3 className="text-lg leading-tight font-semibold break-words text-bone">{p!.name}</h3>
            <p className="text-xs text-muted-foreground">{p!.author && <>by {p!.author} · </>}{formatDownloads(p!.downloads)} downloads</p>
            <div className="flex flex-wrap items-center gap-2">
              {status && <StatusBadge tone={status === "installed" ? "ok" : "info"}>{status === "installed" ? "Installed" : "In modpack"}</StatusBadge>}
              <a href={p!.pageUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-grass-bright underline-offset-2 hover:underline">
                Open on {platformLabel(platform)} <ExternalLink className="size-3" aria-hidden="true" />
              </a>
            </div>
          </div>
        </div>
        {p!.clientOnly && <p role="note" className="text-sm text-bad">Client-only: this project does not run on servers, so it cannot be added.</p>}
        {platform === "curseforge" && kind === "mod" && <p className="text-xs text-warn">{CF_SERVER_NOTE}</p>}

        <div className="flex flex-col gap-2 rounded-md border border-cobble bg-bedrock/60 p-3">
          <Label htmlFor="cb-version" className="text-xs text-muted-foreground">Version</Label>
          <div className="flex flex-wrap items-center gap-2">
            {versions.isPending ? <span className="h-9 flex-1 animate-pulse rounded-md bg-bedrock-2" /> : versions.isError ? (
              <p role="alert" className="flex-1 text-sm text-bad">{errorText(versions.error)}</p>
            ) : noVersion ? (
              <p className="flex-1 text-sm text-warn">No version of this project fits this server{filter.gameVersion ? ` (Minecraft ${filter.gameVersion}${filter.loaders.length ? `, ${filter.loaders[0]}` : ""})` : ""}.</p>
            ) : (
              <Select value={versionId ?? undefined} onValueChange={pick}>
                <SelectTrigger id="cb-version" className="min-w-0 flex-1"><SelectValue placeholder="Choose a version" /></SelectTrigger>
                <SelectContent>
                  {all.map((v) => (
                    <SelectItem key={v.versionId} value={v.versionId} disabled={!v.installable}>
                      {v.label}{v.type !== "release" ? ` (${v.type})` : ""}{v.installable ? "" : ` — ${v.reason ?? "cannot be installed"}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Button type="button" size="sm" variant={selected ? "secondary" : "default"} disabled={!canSelect && !selected} aria-pressed={selected !== null} onClick={toggle}>
              {selected ? <><Check /> Selected</> : "Select"}
            </Button>
          </div>
          {version && version.gameVersions.length > 0 && (
            <p className="text-xs text-muted-foreground">For Minecraft {version.gameVersions.slice(0, 4).join(", ")}{version.gameVersions.length > 4 ? "…" : ""}{version.loaders.length ? ` · ${version.loaders.join(", ")}` : ""}</p>
          )}
          {versions.data?.stale && <p className="text-xs text-warn">The source is not responding: these versions may be out of date.</p>}
        </div>

        {deps.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <h4 className="text-xs text-muted-foreground">Dependencies of this version</h4>
            <ul className="flex flex-col gap-1 text-sm">
              {deps.map((d) => {
                const id = d.projectId!;
                const present = installed.has(id) || inPack.has(id);
                const note = d.type === "incompatible" ? `incompatible${present ? ": already installed, they cannot be used together" : ""}`
                  : d.type === "optional" ? "optional, not added"
                    : `required · ${installed.has(id) ? "already on the server" : inPack.has(id) ? "in the modpack" : "added with it"}`;
                return (
                  <li key={`${d.type}:${id}`} className="flex flex-wrap items-baseline gap-x-2">
                    <span className={cn("font-medium", d.type === "incompatible" ? "text-bad" : "text-bone")}>{nameOf(id)}</span>
                    <span className="text-xs text-muted-foreground">{note}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {p!.links.length > 0 && (
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
            {p!.links.map((l) => (
              <li key={l.url}><a href={l.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-fog underline-offset-2 hover:text-bone hover:underline">{l.label}<ExternalLink className="size-3" aria-hidden="true" /></a></li>
            ))}
          </ul>
        )}

        {p!.gallery.length > 0 && (
          <ul className="grid grid-cols-3 gap-2" aria-label="Gallery">
            {p!.gallery.slice(0, 6).map((src) => (
              <li key={src}><ContentImage src={src} alt={`${p!.name} screenshot`} className="aspect-video h-auto w-full" /></li>
            ))}
          </ul>
        )}

        <Description html={p!.descriptionHtml} />
      </div>
    </div>
  );
}

function BrowserFooter({ selected, act, review, busy, error, mode, spec, onPrepare, onConfirm, onBack, onCancel }: {
  selected: Selected[]; act: (a: BrowserAction) => void; review: Review | null; busy: boolean; error: string | null; mode: "server" | "new-server";
  spec: EditableSpec; onPrepare: () => void; onConfirm: () => void; onBack: () => void; onCancel: () => void;
}) {
  const blocked = review?.kind === "content" && (review.result.conflicts.length > 0 || review.result.add.length === 0);
  return (
    <footer className="flex flex-col border-t border-cobble bg-bedrock">
      {review && (
        <div className="max-h-[35vh] overflow-y-auto border-b border-cobble px-4 py-3 text-sm" aria-live="polite" data-testid="content-review">
          {review.kind === "pack" ? <PackReview info={review.info} spec={spec} mode={mode} /> : <ContentReview review={review} />}
          {mode === "server" && <p className="mt-2 text-xs text-muted-foreground">Nothing changes on the server until you save the configuration.</p>}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 text-sm">
          {selected.length === 0 ? (
            <span className="hidden text-muted-foreground sm:inline">Select {mode === "new-server" ? "a modpack" : "projects"} to add {mode === "new-server" ? "it" : "them"} to the server.</span>
          ) : (
            <>
              <span className="mr-1 text-muted-foreground tabular-nums">{selected.length} selected</span>
              {selected.slice(0, 5).map((it) => (
                <span key={it.projectId} className="inline-flex max-w-48 items-center gap-1 rounded-sm border border-cobble-2 bg-bedrock-2 py-0.5 pr-1 pl-2 text-xs">
                  <span className="truncate">{it.name}</span>
                  <button type="button" aria-label={`Remove ${it.name} from the selection`} onClick={() => act({ type: "toggle", item: it })}
                    className="rounded-xs p-0.5 text-muted-foreground hover:text-bone"><X className="size-3" /></button>
                </span>
              ))}
              {selected.length > 5 && <span className="text-xs text-muted-foreground">+{selected.length - 5} more</span>}
            </>
          )}
          {error && <p role="alert" className="w-full text-sm text-bad">{error}</p>}
        </div>
        <div className="flex items-center gap-2">
          {review ? (
            <>
              <Button type="button" variant="ghost" onClick={onBack}>Back</Button>
              <Button type="button" disabled={blocked} onClick={onConfirm} data-testid="content-confirm">
                {review.kind === "pack" ? (mode === "new-server" ? "Use this modpack" : spec.modpack ? "Switch to this modpack" : "Install this modpack") : addSummary(review.result)}
              </Button>
            </>
          ) : (
            <>
              <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
              <Button type="button" disabled={selected.length === 0 || busy} onClick={onPrepare} data-testid="content-add">
                {busy && <LoaderCircle className="animate-spin" />}
                {busy ? "Checking dependencies…" : mode === "new-server" ? "Continue" : "Add to server"}
              </Button>
            </>
          )}
        </div>
      </div>
    </footer>
  );
}

function ContentReview({ review }: { review: Extract<Review, { kind: "content" }> }) {
  const { add, optional, inPack, conflicts, unresolved } = review.result;
  return (
    <div className="flex flex-col gap-2">
      {conflicts.length > 0 && (
        <div role="alert" className="text-bad">
          <p className="font-medium">These cannot be added together:</p>
          <ul className="list-inside list-disc">{conflicts.map((c) => <li key={c}>{c}</li>)}</ul>
        </div>
      )}
      {add.length > 0 && (
        <div>
          <p className="mb-1 font-medium text-bone">{addSummary(review.result)}</p>
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-x-6 gap-y-0.5">
            {add.map((e) => (
              <li key={e.projectId} className="flex items-baseline gap-2">
                <span className={cn("led", e.selected ? "text-ok" : "text-info")} aria-hidden="true" />
                <span className="truncate">{e.name}</span>
                {!e.selected && e.requiredBy.length > 0 && <span className="truncate text-xs text-muted-foreground">dependency of {e.requiredBy.join(", ")}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {add.length === 0 && conflicts.length === 0 && <p className="text-muted-foreground">Everything selected is already on the server.</p>}
      {unresolved.map((u) => <p key={u} className="text-warn">{u}</p>)}
      {review.warnings.map((w) => <p key={w} className="text-warn">{w}</p>)}
      {inPack.length > 0 && <p className="text-xs text-muted-foreground">Already in the modpack: {inPack.map((p) => p.name).join(", ")}</p>}
      {optional.length > 0 && <p className="text-xs text-muted-foreground">Optional, not added: {optional.map((o) => `${o.name} (for ${o.requiredBy.join(", ")})`).join(", ")}</p>}
    </div>
  );
}

function PackReview({ info, spec, mode }: { info: PackInfoDto; spec: EditableSpec; mode: "server" | "new-server" }) {
  const versionChanges = mode === "server" && info.minecraftVersion !== null && info.minecraftVersion !== spec.version;
  return (
    <div className="flex items-start gap-3">
      <ContentImage src={info.iconUrl} alt="" size="lg" />
      <div className="flex min-w-0 flex-col gap-1">
        <p className="font-medium text-bone">{info.name} <span className="font-normal text-fog">{info.versionLabel}</span></p>
        <p className="text-xs text-muted-foreground">
          Minecraft {info.minecraftVersion ?? "unknown"}{info.loader ? ` · ${info.loader}${info.loaderVersion ? ` ${info.loaderVersion}` : ""}` : ""}
          {" · "}the server type becomes {info.platform === "modrinth" ? "Modrinth modpack" : "CurseForge modpack"}
        </p>
        {versionChanges && <p className="text-xs text-warn">{WORLD_VERSION_NOTE}: this pack runs Minecraft {info.minecraftVersion} and the server is on {spec.version}.</p>}
        {!info.contentsKnown && info.reason && <p className="text-xs text-warn">{info.reason}: the browser cannot mark what the pack already brings.</p>}
      </div>
    </div>
  );
}

function NotBrowsable({ reason, pinTo, spec, onApply }: { reason: string; pinTo?: "release"; spec: EditableSpec; onApply: (s: EditableSpec) => void }) {
  const vanilla = useVersions("VANILLA", pinTo === "release");
  const release = vanilla.data?.versions.find((v) => v.stable)?.id ?? null;
  return (
    <Blocked icon={pinTo ? <PackageSearch /> : <LoaderCircle className="animate-spin" />} title={pinTo ? "Choose a Minecraft version" : "Not ready yet"}>
      <p>{reason}</p>
      {pinTo && (
        <Button type="button" size="sm" className="mt-3" disabled={!release} onClick={() => release && onApply(withVersion(spec, release).spec)}>
          {release ? `Pin Minecraft version to ${release}` : vanilla.isError ? "The version list is not available" : "Loading versions…"}
        </Button>
      )}
    </Blocked>
  );
}

function Blocked({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="m-auto flex max-w-md flex-col items-center gap-2 p-8 text-center text-sm text-muted-foreground">
      <span className="text-cobble-2 [&_svg]:size-9" aria-hidden="true">{icon}</span>
      <p className="font-medium text-bone">{title}</p>
      <div>{children}</div>
    </div>
  );
}
