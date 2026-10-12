import { Info } from "lucide-react";
import type { ServerDto } from "@/lib/api";
import { importNotices } from "@/lib/import";

/** Avisos de un servidor importado (cabecera de su página): adopción pendiente, Compose y datos fuera de DATA_ROOT. */
export function ImportNotices({ server }: { server: ServerDto }) {
  const notes = importNotices(server);
  if (notes.length === 0) return null;
  return (
    <div data-testid="import-notices" className="mt-2 flex max-w-3xl flex-col gap-1 rounded-md border border-sky-900 bg-sky-950/30 p-2 text-sm text-sky-200">
      {notes.map((n) => <p key={n} className="flex gap-2"><Info className="mt-0.5 size-4 shrink-0" />{n}</p>)}
    </div>
  );
}

/** Explicación en lugar de una pestaña que no aplica a este servidor (p. ej. datos fuera de DATA_ROOT). */
export function ExternalDataNote({ text }: { text: string }) {
  return (
    <div role="note" className="flex max-w-3xl gap-2 rounded-md border border-sky-900 bg-sky-950/30 p-3 text-sm text-sky-200">
      <Info className="mt-0.5 size-4 shrink-0" />{text}
    </div>
  );
}
