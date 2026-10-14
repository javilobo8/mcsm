import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Copy, Pencil, Plus, Rocket, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api, apiPath, ApiError, type TemplateDto } from "@/lib/api";
import { typeLabel } from "@/lib/spec-catalog";
import { useTemplates } from "@/hooks/use-templates";
import { useServers } from "@/hooks/use-servers";
import { PAGE, PageHeader } from "@/components/page-header";

/** Templates page: list, create, edit, duplicate, delete and "create server from template". */
export function TemplatesPage() {
  const templates = useTemplates();
  const servers = useServers();
  const qc = useQueryClient();
  const [toDelete, setToDelete] = useState<TemplateDto | null>(null);
  const duplicate = useMutation({
    mutationFn: (id: string) => api.post<TemplateDto>(apiPath`/api/templates/${id}/duplicate`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["templates"] }); },
  });
  const del = useMutation({
    mutationFn: (id: string) => api.del(apiPath`/api/templates/${id}`),
    onSuccess: (_d, id) => {
      setToDelete(null);
      qc.removeQueries({ queryKey: ["template", id] });
      void qc.invalidateQueries({ queryKey: ["templates"] });
    },
  });
  const serverName = (id: string | null) => (id ? servers.data?.find((s) => s.id === id)?.name : undefined);
  const actionError = duplicate.error ?? del.error;

  return (
    <div className={PAGE}>
      <PageHeader
        title="Templates"
        description="A template stores all of a server's configuration except name, ports and RCON password. Create them from scratch or with “Save as template” in a server's configuration."
        actions={<Button asChild><Link to="/templates/new"><Plus className="size-4" /> New template</Link></Button>}
      />
      {templates.isError && <p role="alert" className="text-sm text-bad">Could not load the templates: {templates.error.message}</p>}
      {actionError && <p role="alert" className="text-sm text-bad">{actionError instanceof ApiError ? actionError.message : "Unexpected error"}</p>}
      <Table>
        <TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Type</TableHead><TableHead>Memory</TableHead><TableHead>Source</TableHead><TableHead><span className="sr-only">Actions</span></TableHead></TableRow></TableHeader>
        <TableBody>
          {templates.isPending && <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground">Loading templates…</TableCell></TableRow>}
          {templates.data?.length === 0 && <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground">No templates yet.</TableCell></TableRow>}
          {templates.data?.map((t) => (
            <TableRow key={t.id} data-testid={`template-row-${t.id}`}>
              <TableCell>
                <Link to="/templates/$templateId" params={{ templateId: t.id }} className="font-medium text-bone hover:underline">{t.name}</Link>
                {t.description && <div className="max-w-md truncate text-xs text-muted-foreground">{t.description}</div>}
              </TableCell>
              <TableCell>{typeLabel(t.spec.type)} {t.spec.version}{t.spec.modpack ? ` · ${t.spec.modpack.slugOrUrl}` : ""}</TableCell>
              <TableCell>{t.spec.memory}</TableCell>
              <TableCell className="text-sm text-muted-foreground">{t.sourceServerId ? `“${serverName(t.sourceServerId) ?? "server"}”` : "—"}</TableCell>
              <TableCell>
                <div className="flex justify-end gap-1">
                  <Button asChild size="sm" variant="secondary"><Link to="/servers/new" search={{ template: t.id }}><Rocket className="size-4" /> Create server</Link></Button>
                  <Button asChild size="icon" variant="ghost" aria-label={`Edit ${t.name}`}><Link to="/templates/$templateId" params={{ templateId: t.id }}><Pencil className="size-4" /></Link></Button>
                  <Button size="icon" variant="ghost" aria-label={`Duplicate ${t.name}`} disabled={duplicate.isPending} onClick={() => duplicate.mutate(t.id)}><Copy className="size-4" /></Button>
                  <Button size="icon" variant="ghost" aria-label={`Delete ${t.name}`} onClick={() => { del.reset(); setToDelete(t); }}><Trash2 className="size-4" /></Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <Dialog open={toDelete !== null} onOpenChange={(o) => { if (!o && !del.isPending) setToDelete(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete the template “{toDelete?.name}”</DialogTitle>
            <DialogDescription>Servers created from it are not affected.</DialogDescription>
          </DialogHeader>
          {del.error && <p role="alert" className="text-sm text-bad">{del.error instanceof ApiError ? del.error.message : "Unexpected error"}</p>}
          <DialogFooter>
            <Button variant="ghost" disabled={del.isPending} onClick={() => setToDelete(null)}>Cancel</Button>
            <Button variant="destructive" disabled={del.isPending} onClick={() => toDelete && del.mutate(toDelete.id)}>{del.isPending ? "Deleting…" : "Delete"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
