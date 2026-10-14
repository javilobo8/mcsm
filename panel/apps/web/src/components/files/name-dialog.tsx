import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { validateNewName } from "@/lib/files";
import { dialogSubmit } from "@/lib/dialog-form";

interface Props {
  open: boolean;
  title: string;
  confirmLabel: string;
  initial?: string;
  existing: readonly string[];
  pending: boolean;
  error: string | null;
  onConfirm(name: string): void;
  onOpenChange(open: boolean): void;
}

/** Asks for a name (new folder or rename), validating in the browser before calling the API. */
export function NameDialog({ open, title, confirmLabel, initial = "", existing, pending, error, onConfirm, onOpenChange }: Props) {
  const [name, setName] = useState(initial);
  useEffect(() => { if (open) setName(initial); }, [open, initial]);
  const invalid = validateNewName(name, existing, initial || undefined);
  const unchanged = initial !== "" && name.trim() === initial;
  const submit = () => {
    if (!invalid && !unchanged && !pending) onConfirm(name.trim());
  };
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!pending) onOpenChange(o); }}>
      <DialogContent>
        <form onSubmit={dialogSubmit(submit)} className="flex flex-col gap-3">
          <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>No slashes or “..”. The name is applied in the current folder.</DialogDescription></DialogHeader>
          <Input aria-label="Name" autoFocus value={name} onChange={(e) => setName(e.target.value)} aria-invalid={name !== "" && !!invalid} />
          {name !== "" && invalid && <p className="text-sm text-bad">{invalid}</p>}
          {error && <p role="alert" className="text-sm text-bad">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={pending} onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={!!invalid || unchanged || pending}>{pending ? "Saving…" : confirmLabel}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
