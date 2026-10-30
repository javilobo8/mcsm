import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowUpCircle, FileText, LoaderCircle, Repeat, Search, Trash2 } from "lucide-react";
import { pickLatest, type ContentPlatform } from "@mcsm/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SectionTitle } from "@/components/page-header";
import { StatusBadge } from "@/components/status";
import { ModpackFields } from "@/components/spec-form/modpack-fields";
import { ApiError } from "@/lib/api";
import { platformLabel } from "@/lib/content-browser";
import { withPackInstalled, withPackUninstalled } from "@/lib/content-pack";
import type { EditableSpec } from "@/lib/spec-edit";
import { packQuery, useInstalledPack } from "@/hooks/use-content";
import { ContentBrowserDialog } from "./browser-dialog";
import { ContentImage } from "./content-image";

const errorText = (e: unknown) => (e instanceof Error ? e.message : "Unexpected error");

/**
 * The installed Modrinth or CurseForge pack: what it is, what it runs, and its lifecycle (change version, switch,
 * uninstall). Every action edits the form; Save applies it (and offers a backup before risky pack changes).
 */
export function PackCard({ spec, onChange }: { spec: EditableSpec; onChange: (s: EditableSpec) => void }) {
  const qc = useQueryClient();
  const mp = spec.modpack!;
  const platform: ContentPlatform = mp.platform === "MODRINTH" ? "modrinth" : "curseforge";
  const pack = useInstalledPack(mp);
  const info = pack.info.data ?? null;
  const versions = pack.versions.data?.versions ?? [];
  const current = versions.find((v) => v.versionId === pack.versionId) ?? null;
  const newest = pickLatest(versions.filter((v) => v.installable), current?.type ?? null);
  const update = newest && current && newest.publishedAt > current.publishedAt ? newest : null;
  const [text, setText] = useState(false);
  const [browse, setBrowse] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const empty = mp.slugOrUrl === "";

  // A new version may bring another Minecraft version or loader: read its details and install it like a new pick,
  // keeping how the pack is written in the spec (a slug stays a slug: it is not a switch).
  const changeVersion = async (versionId: string) => {
    if (!pack.projectId || versionId === pack.versionId) return;
    setBusy(true); setError(null);
    try {
      const next = withPackInstalled(spec, await qc.fetchQuery(packQuery({ platform, projectId: pack.projectId, versionId })));
      onChange({ ...next, modpack: { ...next.modpack!, slugOrUrl: mp.slugOrUrl } });
    } catch (e) {
      onChange({ ...spec, modpack: { ...mp, versionId } });
      setError(`Could not read that version's details (${errorText(e)}): only the pack version was changed.`);
    } finally {
      setBusy(false);
    }
  };
  const uninstall = () => {
    setError(null);
    const r = withPackUninstalled(spec, info);
    if (r.ok) onChange(r.spec);
    else setError(r.error);
  };

  const infoError = pack.info.error ?? pack.versions.error ?? pack.searchError;
  const loading = !empty && !info && !infoError && !pack.slugNotFound && pack.ref !== null;
  const details = info
    ? [`Minecraft ${info.minecraftVersion ?? "unknown"}`, info.loader ? `${info.loader}${info.loaderVersion ? ` ${info.loaderVersion}` : ""}` : null].filter(Boolean).join(" · ")
    : null;

  return (
    <section aria-labelledby="sf-content-modpack" className="flex flex-col gap-3 rounded-md border border-border p-3" data-testid="pack-card">
      <div className="flex flex-wrap items-center gap-2">
        <SectionTitle className="text-sm"><span id="sf-content-modpack">Modpack</span></SectionTitle>
        <Badge variant="outline" className="px-1.5 py-0 text-[11px] font-normal text-fog">{platformLabel(platform)}</Badge>
        <Button type="button" size="sm" variant="ghost" className="ml-auto" aria-pressed={text} onClick={() => setText((t) => !t)}><FileText /> Edit as text</Button>
      </div>

      {text ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3"><ModpackFields spec={spec} onChange={onChange} /></div>
      ) : empty ? (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-dashed border-cobble px-3 py-4 text-sm text-muted-foreground">
          <span className="flex-1">No modpack chosen yet. Pick one from {platformLabel(platform)} or type it with Edit as text.</span>
          <Button type="button" size="sm" onClick={() => setBrowse(true)}><Search /> Choose a modpack</Button>
        </div>
      ) : (
        <>
          <div className="flex items-start gap-4">
            <ContentImage src={info?.iconUrl} alt="" size="lg" />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              {loading ? (
                <>
                  <span className="h-5 w-48 animate-pulse rounded-sm bg-bedrock-2" />
                  <span className="h-3 w-64 animate-pulse rounded-sm bg-bedrock-2" />
                </>
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-base font-semibold break-words text-bone">{info?.name ?? mp.slugOrUrl}</span>
                    <span className="text-sm text-fog">{info?.versionLabel ?? current?.label ?? (mp.versionId || "latest version")}</span>
                    {update && <StatusBadge tone="info">Update available: {update.label}</StatusBadge>}
                  </div>
                  {details && <p className="text-xs text-muted-foreground">{details}</p>}
                </>
              )}
              {pack.slugNotFound && <p className="text-xs text-warn">“{pack.ref?.slug}” was not found on CurseForge: check it with Edit as text.</p>}
              {infoError && <p className="text-xs text-muted-foreground">{infoError instanceof ApiError && infoError.status === 404 ? infoError.message : `Could not load the modpack's details: ${errorText(infoError)}`}</p>}
              {pack.ref === null && <p className="text-xs text-muted-foreground">This pack is written in a way the browser cannot look up: use Edit as text.</p>}
              {info && !info.contentsKnown && info.reason && <p className="text-xs text-muted-foreground">{info.reason}.</p>}
            </div>
          </div>
          <div className="flex flex-wrap items-end gap-2 border-t border-cobble/60 pt-3">
            <div className="flex min-w-56 flex-col gap-1.5">
              <Label htmlFor="sf-mp-change" className="text-xs text-muted-foreground">Change version</Label>
              <Select value={pack.versionId ?? undefined} onValueChange={(v) => void changeVersion(v)} disabled={busy || versions.length === 0}>
                <SelectTrigger id="sf-mp-change" size="sm" className="w-full">
                  <SelectValue placeholder={pack.versions.isPending && pack.projectId ? "Loading versions…" : "No versions available"} />
                </SelectTrigger>
                <SelectContent>
                  {versions.map((v) => (
                    <SelectItem key={v.versionId} value={v.versionId} disabled={!v.installable}>
                      {v.label}{v.type !== "release" ? ` (${v.type})` : ""}{v.gameVersions[0] ? ` · Minecraft ${v.gameVersions.join(", ")}` : ""}{v.installable ? "" : ` — ${v.reason ?? "cannot be installed"}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {update && (
              <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => void changeVersion(update.versionId)}>
                {busy ? <LoaderCircle className="animate-spin" /> : <ArrowUpCircle className="text-info" />} Update to {update.label}
              </Button>
            )}
            <div className="ml-auto flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="outline" onClick={() => setBrowse(true)}><Repeat /> Switch modpack</Button>
              <Button type="button" size="sm" variant="ghost" className="text-bad hover:text-bad" disabled={busy} onClick={uninstall}><Trash2 /> Uninstall</Button>
            </div>
          </div>
        </>
      )}
      {error && <p role="alert" className="text-xs text-bad">{error}</p>}
      <ContentBrowserDialog open={browse} onOpenChange={setBrowse} spec={spec} pack={info} mode="server" initialTab={{ platform, kind: "modpack" }} onApply={onChange} />
    </section>
  );
}
