import { Link } from "@tanstack/react-router";
import { ArrowUpCircle, LoaderCircle, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { platformLabel } from "@/lib/content-browser";
import { unresolvedNote, type InstalledRow } from "@/lib/content-installed";
import { cn } from "@/lib/utils";
import { ContentImage } from "./content-image";

/**
 * A content section's entries as a list: icon, name, source, version, pinned/latest, who requires it, update, remove.
 * `loading`: the lookup has not answered for some rows yet (they are not "not found", just not known).
 */
export function InstalledList({ rows, loading, lookupFailed, busy, onUpdate, onRemove }: {
  rows: readonly InstalledRow[]; loading: boolean; lookupFailed: boolean; busy: string | null;
  onUpdate(row: InstalledRow): void; onRemove(row: InstalledRow): void;
}) {
  return (
    <ul className="flex flex-col overflow-hidden rounded-md border border-cobble bg-deepslate/40" data-testid="installed-list">
      {rows.map((r) => (
        <li key={`${r.list}:${r.raw}`} className="flex items-center gap-3 border-b border-cobble/60 px-3 py-2 last:border-b-0" data-testid="installed-row">
          <ContentImage src={r.iconUrl} alt="" size="sm" />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className={cn("truncate text-sm font-medium text-bone", !r.resolved && "font-mono text-xs font-normal")}>{r.name}</span>
              <Badge variant="outline" className="px-1.5 py-0 text-[11px] font-normal text-fog">{platformLabel(r.platform)}</Badge>
            </div>
            <p className="truncate text-xs text-muted-foreground">
              {[r.versionLabel, r.pinned ? "pinned" : r.resolved ? "latest" : "as typed", r.dependencyOf.length > 0 ? `Dependency of ${r.dependencyOf.join(", ")}` : null]
                .filter(Boolean).join(" · ")}
            </p>
            <UnresolvedNote row={r} loading={loading} lookupFailed={lookupFailed} />
            {!r.checked && <p className="text-xs text-muted-foreground">Couldn't check for updates</p>}
          </div>
          {r.update && (
            <Button type="button" size="xs" variant="secondary" disabled={busy !== null} onClick={() => onUpdate(r)} title={`Update ${r.name} to ${r.update.label}`}>
              {busy === r.raw ? <LoaderCircle className="animate-spin" /> : <ArrowUpCircle className="text-info" />}
              <span className="max-w-40 truncate">Update to {r.update.label}</span>
            </Button>
          )}
          <Button type="button" size="icon-sm" variant="ghost" disabled={busy !== null} aria-label={`Remove ${r.name}`} onClick={() => onRemove(r)}>
            <Trash2 />
          </Button>
        </li>
      ))}
    </ul>
  );
}

function UnresolvedNote({ row, loading, lookupFailed }: { row: InstalledRow; loading: boolean; lookupFailed: boolean }) {
  switch (unresolvedNote(row, { loading, lookupFailed })) {
    case "loading": return <p className="text-xs text-muted-foreground">Loading details…</p>;
    case "unavailable": return <p className="text-xs text-muted-foreground">Details are not available right now: shown as typed</p>;
    case "no_key":
      return (
        <p className="text-xs text-muted-foreground">
          <Link to="/settings" className="text-grass-bright underline-offset-2 hover:underline">Save a CurseForge API key in Settings</Link> to see its details.
        </p>
      );
    case "not_found": return <p className="text-xs text-warn">Not found on {platformLabel(row.platform)}: shown as typed</p>;
    default: return null;
  }
}

