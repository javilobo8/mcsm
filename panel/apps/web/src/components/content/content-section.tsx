import { useState } from "react";
import { FileText, Search } from "lucide-react";
import {
  CONTENT_LISTS, CONTENT_LIST_KEYS,
  type ContentKind, type ContentListKey, type ContentLoader, type ContentSection as Section, type ContentTarget, type PackInfoDto,
} from "@mcsm/shared";
import { Button } from "@/components/ui/button";
import { SectionTitle } from "@/components/page-header";
import { ListField, type ReportError } from "@/components/spec-form/fields";
import { applyUpdates } from "@/lib/content-compat";
import { applyResolved, unusedAfterRemoval } from "@/lib/content-deps";
import { installedRows, type InstalledRow } from "@/lib/content-installed";
import { listOf, presentFor, removeEntries, withSectionField } from "@/lib/content-lists";
import { browserTabs, CURSEFORGE_PLUGINS } from "@/lib/content-target";
import type { EditableSpec } from "@/lib/spec-edit";
import type { ListItemKind } from "@/lib/spec-edit";
import { resolveContent, useContentLookup, useContentUpdates, type ListUpdate } from "@/hooks/use-content";
import { ContentBrowserDialog } from "./browser-dialog";
import { InstalledList } from "./installed-list";
import { RemoveDialog } from "./remove-dialog";

interface TextFieldDef { id: string; field: string; label: string; kind?: ListItemKind; placeholder: string; hint: string; optional?: boolean }

const URL_HINT = "One http(s) URL per line. Removing a URL does not delete the .jar already downloaded.";
/** "Edit as text" view of each section: today's textareas (same ids, labels and hints), plus the new lists. */
const TEXT_FIELDS: Record<Section, TextFieldDef[]> = {
  mods: [
    { id: "sf-mods-modrinth", field: "modrinthProjects", label: "Modrinth mods (MODRINTH_PROJECTS)", placeholder: "lithium\nferritecore:beta", hint: "Slug or id per line; “:beta” or “:version” to pin." },
    { id: "sf-mods-cf", field: "curseforgeFiles", label: "CurseForge (CURSEFORGE_FILES)", placeholder: "jei\njei:4593548", hint: "Slug, id, slug:file or URL per line." },
    { id: "sf-mods-urls", field: "urls", kind: "url", label: ".jar URLs (MODS)", placeholder: "https://…/mod.jar", hint: URL_HINT },
  ],
  plugins: [
    { id: "sf-pl-modrinth", field: "modrinthProjects", label: "Modrinth plugins (MODRINTH_PROJECTS)", placeholder: "luckperms\nchunky", hint: "Slug or id per line." },
    // Optional: old specs have no key, and the template editor only shows it when the spec has one (no phantom diff).
    { id: "sf-pl-cf", field: "curseforgeFiles", label: "CurseForge plugins (CURSEFORGE_FILES)", placeholder: "worldedit\n225608:5830452", hint: "Slug, id or id:file per line.", optional: true },
    { id: "sf-pl-spiget", field: "spigetResources", kind: "digits", label: "Spiget (SPIGET_RESOURCES)", placeholder: "28140\n34315", hint: "SpigotMC numeric id per line. Some (e.g. EssentialsX) do not allow automatic download." },
    { id: "sf-pl-urls", field: "urls", kind: "url", label: ".jar URLs (PLUGINS)", placeholder: "https://…/plugin.jar", hint: URL_HINT },
  ],
  datapacks: [
    { id: "sf-dp-modrinth", field: "modrinthProjects", label: "Modrinth datapacks (MODRINTH_PROJECTS with datapack:)", placeholder: "terralith\nincendium", hint: "Slug or id per line; “:version” to pin." },
  ],
};

/**
 * The textareas of one content section. `allOptional`: also the lists the spec does not have yet (the browser's text
 * view); without it (template editor, text mode) an optional list only appears when the spec carries it.
 */
export function ContentTextFields({ spec, onChange, onError, section, allOptional }: {
  spec: EditableSpec; onChange: (s: EditableSpec) => void; onError?: ReportError; section: Section; allOptional: boolean;
}) {
  const values = (spec[section] ?? {}) as Record<string, string[] | undefined>;
  const fields = TEXT_FIELDS[section].filter((f) => !f.optional || allOptional || values[f.field] !== undefined);
  return (
    <div className={`grid grid-cols-1 gap-3 ${fields.length > 1 ? "sm:grid-cols-3" : ""}`}>
      {fields.map((f) => (
        <ListField key={f.id} onError={onError} id={f.id} label={f.label} kind={f.kind} value={values[f.field] ?? []} placeholder={f.placeholder} hint={f.hint}
          onChange={(l) => onChange(withSectionField(spec, section, f.field, l))} />
      ))}
    </div>
  );
}

const allEntries = (spec: EditableSpec) => CONTENT_LIST_KEYS.flatMap((list) => listOf(spec, list).map((entry) => ({ list, entry })));
const errorText = (e: unknown) => (e instanceof Error ? e.message : "Unexpected error");

type Notice = { tone: "ok" | "warn" | "bad"; text: string };
const TONE_TEXT = { ok: "text-ok", warn: "text-warn", bad: "text-bad" } as const;

/**
 * One content section of "Version and mods" in browser mode: installed list, "Browse", "Edit as text", updates and
 * removal. Everything edits the unsaved form; Save applies it.
 */
export function ContentSection({ spec, onChange, lists, title, kind, target, pack, packError = null, onError }: {
  spec: EditableSpec; onChange: (s: EditableSpec) => void; lists: ContentListKey[]; title: string; kind: ContentKind;
  target: ContentTarget | null; pack: PackInfoDto | null; packError?: string | null; onError?: ReportError;
}) {
  const [text, setText] = useState(false);
  const [browse, setBrowse] = useState(false);
  const [removing, setRemoving] = useState<InstalledRow | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const section = CONTENT_LISTS[lists[0]!].section;
  const lookup = useContentLookup(text ? [] : allEntries(spec));
  const metas = lookup.data ?? [];
  const updates = useContentUpdates(spec, lists, target, !text);
  const rows = installedRows(spec, metas, updates.updates).filter((r) => lists.includes(r.list));
  const pending = updates.updates.filter((u) => u.latest && rows.some((r) => r.list === u.list && r.raw === u.entry));
  const tab = browserTabs(spec.type, { curseforgePlugins: CURSEFORGE_PLUGINS }).find((t) => t.kind === kind);
  const values = (spec[section] ?? {}) as Record<string, string[] | undefined>;
  const others = (values.urls?.length ?? 0) + (values.spigetResources?.length ?? 0);
  const titleId = `sf-content-${section}`;

  // Update one or all: move to the newest compatible version, then add whatever new dependencies it requires.
  const update = async (us: ListUpdate[], key: string) => {
    if (!target) return;
    setBusy(key); setNotice(null);
    try {
      let next = applyUpdates(spec, us).spec;
      const warnings: string[] = [];
      for (const list of lists) {
        const { platform } = CONTENT_LISTS[list];
        const selections = us.filter((u) => u.list === list && u.latest && u.projectId).map((u) => ({ projectId: u.projectId!, versionId: u.latest!.versionId }));
        for (let i = 0; i < selections.length; i += 50) {
          const r = await resolveContent({
            list, selections: selections.slice(i, i + 50), present: presentFor(next, platform),
            target: { gameVersion: target.gameVersion, loaders: target.loaders as ContentLoader[] },
            pack: pack && pack.platform === platform ? { platform, projectId: pack.projectId, versionId: pack.versionId } : null,
          });
          if (r.conflicts.length > 0) { setNotice({ tone: "bad", text: `Not updated: ${r.conflicts.join("; ")}` }); return; }
          warnings.push(...r.unresolved);
          next = applyResolved(next, r);
        }
      }
      onChange(next);
      setNotice(warnings.length ? { tone: "warn", text: warnings.join("; ") } : { tone: "ok", text: `${us.length === 1 ? "Updated" : `Updated ${us.length} entries`}. Save the configuration to apply it.` });
    } catch (e) {
      setNotice({ tone: "bad", text: errorText(e) });
    } finally {
      setBusy(null);
    }
  };

  const present = metas.filter((m) => listOf(spec, m.list).includes(m.raw));
  const removedMeta = removing ? present.find((m) => m.list === removing.list && m.raw === removing.raw) : undefined;
  const unused = removing && removedMeta ? unusedAfterRemoval([removedMeta], present.filter((m) => m !== removedMeta)) : [];
  const remove = (alsoRemove: string[]) => {
    if (!removing) return;
    let next = removeEntries(spec, removing.list, [removing.raw]);
    for (const m of unused) if (alsoRemove.includes(m.raw)) next = removeEntries(next, m.list, [m.raw]);
    onChange(next);
    setRemoving(null);
  };

  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-3 rounded-md border border-border p-3" data-testid={`content-section-${section}`}>
      <div className="flex flex-wrap items-center gap-2">
        <SectionTitle className="flex items-baseline gap-2 text-sm">
          <span id={titleId}>{title}</span>
          {rows.length > 0 && <span className="font-normal text-muted-foreground tabular-nums">{rows.length}</span>}
        </SectionTitle>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {!text && pending.length > 0 && (
            <Button type="button" size="sm" variant="secondary" disabled={busy !== null || !target} onClick={() => void update(pending, "all")}>
              Update all ({pending.length})
            </Button>
          )}
          <Button type="button" size="sm" variant="ghost" aria-pressed={text} onClick={() => setText((t) => !t)}><FileText /> Edit as text</Button>
          {tab && <Button type="button" size="sm" onClick={() => setBrowse(true)}><Search /> Browse</Button>}
        </div>
      </div>

      {text ? (
        <ContentTextFields spec={spec} onChange={onChange} onError={onError} section={section} allOptional />
      ) : rows.length > 0 ? (
        <InstalledList rows={rows} loading={lookup.isPending || lookup.isPlaceholderData} lookupFailed={lookup.isError} busy={busy}
          onUpdate={(r) => { const u = updates.updates.find((x) => x.list === r.list && x.entry === r.raw); if (u) void update([u], r.raw); }}
          onRemove={setRemoving} />
      ) : (
        <p className="rounded-md border border-dashed border-cobble px-3 py-4 text-center text-sm text-muted-foreground">
          No {title.toLowerCase()} yet.{tab ? " Use Browse to add compatible ones." : " Add them with Edit as text."}
        </p>
      )}
      {!text && others > 0 && <p className="text-xs text-muted-foreground">Also {others} by URL or Spiget: use Edit as text to change them.</p>}
      {!text && updates.error && <p className="text-xs text-muted-foreground">Couldn't check for updates: {errorText(updates.error)}</p>}
      {notice && <p role={notice.tone === "bad" ? "alert" : "status"} className={`text-xs ${TONE_TEXT[notice.tone]}`}>{notice.text}</p>}

      {tab && <ContentBrowserDialog open={browse} onOpenChange={setBrowse} spec={spec} pack={pack} packError={packError} mode="server" initialTab={tab} onApply={onChange} />}
      <RemoveDialog key={removing ? `${removing.list}:${removing.raw}` : "none"} open={removing !== null} row={removing} unused={unused}
        onConfirm={remove} onCancel={() => setRemoving(null)} />
    </section>
  );
}
