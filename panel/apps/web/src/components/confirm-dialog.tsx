import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface Props {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** Mutación en vuelo: el diálogo no se cierra (ni con Escape ni con el aspa) y los botones se bloquean. */
  pending?: boolean;
  error?: string | null;
  onConfirm(): void;
  onCancel(): void;
}

/** Confirmación de una acción destructiva o que descarta cambios (sustituye a window.confirm). */
export function ConfirmDialog({ open, title, description, confirmLabel, cancelLabel = "Cancelar", pending = false, error = null, onConfirm, onCancel }: Props) {
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
          <Button type="button" variant="destructive" disabled={pending} onClick={onConfirm}>{pending ? "Trabajando…" : confirmLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
