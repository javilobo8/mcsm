import { useState } from "react";
import type { ContentEntryMetaDto } from "@mcsm/shared";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { dialogSubmit } from "@/lib/dialog-form";
import type { InstalledRow } from "@/lib/content-installed";

/**
 * Confirms removing one entry and offers the dependencies nobody else needs (all checked by default). It only edits the
 * form: the Save confirmation applies it (and offers a backup first). Mount it with `key` = the row so choices reset.
 */
export function RemoveDialog({ open, row, unused, onConfirm, onCancel }: {
  open: boolean; row: InstalledRow | null; unused: readonly ContentEntryMetaDto[]; onConfirm(alsoRemove: string[]): void; onCancel(): void;
}) {
  const [kept, setKept] = useState<ReadonlySet<string>>(new Set());
  const toggle = (raw: string, on: boolean) => setKept((prev) => { const next = new Set(prev); if (on) next.delete(raw); else next.add(raw); return next; });
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onCancel(); }}>
      <DialogContent className="sm:max-w-md" data-testid="content-remove">
        <DialogHeader>
          <DialogTitle>Remove “{row?.name}”?</DialogTitle>
          <DialogDescription>It is removed from the server when you save the configuration.</DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={dialogSubmit(() => onConfirm(unused.map((m) => m.raw).filter((raw) => !kept.has(raw))))}>
          {unused.length > 0 && (
            <fieldset className="flex flex-col gap-2 rounded-md border border-cobble p-3">
              <legend className="px-1 text-sm font-medium">Also remove unused dependencies</legend>
              <p className="text-xs text-muted-foreground">Nothing else on the server needs them.</p>
              {unused.map((m) => {
                const id = `rm-dep-${m.list}-${m.raw}`;
                return (
                  <div key={`${m.list}:${m.raw}`} className="flex items-center gap-2">
                    <Checkbox id={id} checked={!kept.has(m.raw)} onCheckedChange={(v) => toggle(m.raw, v === true)} />
                    <Label htmlFor={id} className="font-normal">{m.name ?? m.raw}{m.versionLabel && <span className="text-xs text-muted-foreground">{m.versionLabel}</span>}</Label>
                  </div>
                );
              })}
            </fieldset>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
            <Button type="submit" variant="destructive">Remove</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
