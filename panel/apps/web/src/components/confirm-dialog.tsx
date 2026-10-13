import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface Props {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** Mutation in flight: the dialog does not close (neither with Escape nor with the X) and the buttons are disabled. */
  pending?: boolean;
  error?: string | null;
  onConfirm(): void;
  onCancel(): void;
}

/** Confirmation for a destructive action or one that discards changes (replaces window.confirm). */
export function ConfirmDialog({ open, title, description, confirmLabel, cancelLabel = "Cancel", pending = false, error = null, onConfirm, onCancel }: Props) {
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !pending) onCancel(); }}>
      <DialogContent showCloseButton={!pending} onEscapeKeyDown={(e) => { if (pending) e.preventDefault(); }} onInteractOutside={(e) => { if (pending) e.preventDefault(); }}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={pending} onClick={onCancel}>{cancelLabel}</Button>
          <Button type="button" variant="destructive" disabled={pending} onClick={onConfirm}>{pending ? "Working…" : confirmLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
