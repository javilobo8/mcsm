import { Info } from "lucide-react";
import type { ServerDto } from "@/lib/api";
import { importNotices } from "@/lib/import";

/** Notices of an imported server (its page header): pending adoption, Compose and data outside DATA_ROOT. */
export function ImportNotices({ server }: { server: ServerDto }) {
  const notes = importNotices(server);
  if (notes.length === 0) return null;
  return (
    <div data-testid="import-notices" className="mt-2 flex max-w-3xl flex-col gap-1 rounded-md border border-diamond/30 bg-diamond/[0.07] p-2 text-sm text-info">
      {notes.map((n) => <p key={n} className="flex gap-2"><Info className="mt-0.5 size-4 shrink-0" />{n}</p>)}
    </div>
  );
}

/** Explanation in place of a tab that does not apply to this server (e.g. data outside DATA_ROOT). */
export function ExternalDataNote({ text }: { text: string }) {
  return (
    <div role="note" className="flex max-w-3xl gap-2 rounded-md border border-diamond/30 bg-diamond/[0.07] p-3 text-sm text-info">
      <Info className="mt-0.5 size-4 shrink-0" />{text}
    </div>
  );
}
