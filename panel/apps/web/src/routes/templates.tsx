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

/** Página Plantillas: lista, crear, editar, duplicar, borrar y "crear servidor desde plantilla". */
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
    <div className="flex flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Plantillas</h1>
        <Button asChild><Link to="/templates/new"><Plus className="size-4" /> Nueva plantilla</Link></Button>
      </div>
      <p className="text-sm text-muted-foreground">Una plantilla guarda toda la configuración de un servidor salvo nombre, puertos y contraseña RCON. Créalas desde cero o con «Guardar como plantilla» en la configuración de un servidor.</p>
      {templates.isError && <p role="alert" className="text-sm text-red-400">No se pudieron cargar las plantillas: {templates.error.message}</p>}
      {actionError && <p role="alert" className="text-sm text-red-400">{actionError instanceof ApiError ? actionError.message : "Error inesperado"}</p>}
      <Table>
        <TableHeader><TableRow><TableHead>Nombre</TableHead><TableHead>Tipo</TableHead><TableHead>Memoria</TableHead><TableHead>Origen</TableHead><TableHead><span className="sr-only">Acciones</span></TableHead></TableRow></TableHeader>
        <TableBody>
          {templates.isPending && <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground">Cargando plantillas…</TableCell></TableRow>}
          {templates.data?.length === 0 && <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground">Aún no hay plantillas.</TableCell></TableRow>}
          {templates.data?.map((t) => (
            <TableRow key={t.id} data-testid={`template-row-${t.id}`}>
              <TableCell>
                <Link to="/templates/$templateId" params={{ templateId: t.id }} className="font-medium hover:underline">{t.name}</Link>
                {t.description && <div className="max-w-md truncate text-xs text-muted-foreground">{t.description}</div>}
              </TableCell>
              <TableCell>{typeLabel(t.spec.type)} {t.spec.version}{t.spec.modpack ? ` · ${t.spec.modpack.slugOrUrl}` : ""}</TableCell>
              <TableCell>{t.spec.memory}</TableCell>
              <TableCell className="text-sm text-muted-foreground">{t.sourceServerId ? `«${serverName(t.sourceServerId) ?? "servidor"}»` : "—"}</TableCell>
              <TableCell>
                <div className="flex justify-end gap-1">
                  <Button asChild size="sm"><Link to="/servers/new" search={{ template: t.id }}><Rocket className="size-4" /> Crear servidor</Link></Button>
                  <Button asChild size="icon" variant="ghost" aria-label={`Editar ${t.name}`}><Link to="/templates/$templateId" params={{ templateId: t.id }}><Pencil className="size-4" /></Link></Button>
                  <Button size="icon" variant="ghost" aria-label={`Duplicar ${t.name}`} disabled={duplicate.isPending} onClick={() => duplicate.mutate(t.id)}><Copy className="size-4" /></Button>
                  <Button size="icon" variant="ghost" aria-label={`Borrar ${t.name}`} onClick={() => { del.reset(); setToDelete(t); }}><Trash2 className="size-4" /></Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <Dialog open={toDelete !== null} onOpenChange={(o) => { if (!o && !del.isPending) setToDelete(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Borrar la plantilla «{toDelete?.name}»</DialogTitle>
            <DialogDescription>Los servidores creados con ella no se ven afectados.</DialogDescription>
          </DialogHeader>
          {del.error && <p role="alert" className="text-sm text-red-400">{del.error instanceof ApiError ? del.error.message : "Error inesperado"}</p>}
          <DialogFooter>
            <Button variant="ghost" disabled={del.isPending} onClick={() => setToDelete(null)}>Cancelar</Button>
            <Button variant="destructive" disabled={del.isPending} onClick={() => toDelete && del.mutate(toDelete.id)}>{del.isPending ? "Borrando…" : "Borrar"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
