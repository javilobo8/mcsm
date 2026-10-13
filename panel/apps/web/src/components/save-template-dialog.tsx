import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { BookmarkPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Field } from "@/components/spec-form/fields";
import { api, ApiError, type ServerDto, type TemplateDto } from "@/lib/api";
import { dialogSubmit } from "@/lib/dialog-form";
import { templateScheduleNote } from "@/lib/backups";

/** "Save as template": copies the server's APPLIED spec without ports or rconPassword (the panel strips them). */
export function SaveTemplateDialog({ server }: { server: ServerDto }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const scheduleNote = templateScheduleNote(server.spec.backups);
  const save = useMutation({
    mutationFn: () => api.post<TemplateDto>("/api/templates", { name: name.trim(), description: description.trim(), fromServerId: server.id }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["templates"] }); },
  });
  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (o) { setName(server.name); setDescription(""); save.reset(); } }}>
      <DialogTrigger asChild><Button type="button" variant="secondary"><BookmarkPlus className="size-4" /> Save as template</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Save “{server.name}” as template</DialogTitle>
          <DialogDescription>Saves the applied configuration (v{server.specVersion}) without ports or RCON password. Unapplied changes are not included.</DialogDescription>
        </DialogHeader>
        {scheduleNote && <p className="text-sm text-amber-300" data-testid="stpl-backups">{scheduleNote}</p>}
        {save.isSuccess ? (
          <div className="flex flex-col gap-3 text-sm">
            <p role="status" className="text-emerald-400">Template “{save.data.name}” created.</p>
            <DialogFooter>
              <Button asChild variant="secondary"><Link to="/templates">View templates</Link></Button>
              <Button type="button" onClick={() => setOpen(false)}>Close</Button>
            </DialogFooter>
          </div>
        ) : (
          <form className="flex flex-col gap-3" onSubmit={dialogSubmit(() => save.mutate())}>
            <Field id="stpl-name" label="Name"><Input id="stpl-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} /></Field>
            <Field id="stpl-desc" label="Description (optional)"><Textarea id="stpl-desc" rows={3} maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
            {save.error && <p role="alert" className="text-sm text-red-400">{save.error instanceof ApiError ? save.error.message : "Unexpected error"}</p>}
            <DialogFooter><Button type="submit" disabled={save.isPending || !name.trim()}>{save.isPending ? "Saving…" : "Save template"}</Button></DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
