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

/** "Guardar como plantilla": copia la spec APLICADA del servidor sin puertos ni rconPassword (lo quita el panel). */
export function SaveTemplateDialog({ server }: { server: ServerDto }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const save = useMutation({
    mutationFn: () => api.post<TemplateDto>("/api/templates", { name: name.trim(), description: description.trim(), fromServerId: server.id }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["templates"] }); },
  });
  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (o) { setName(server.name); setDescription(""); save.reset(); } }}>
      <DialogTrigger asChild><Button type="button" variant="secondary"><BookmarkPlus className="size-4" /> Guardar como plantilla</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Guardar «{server.name}» como plantilla</DialogTitle>
          <DialogDescription>Se guarda la configuración aplicada (v{server.specVersion}) sin puertos ni contraseña RCON. Los cambios sin aplicar no se incluyen.</DialogDescription>
        </DialogHeader>
        {save.isSuccess ? (
          <div className="flex flex-col gap-3 text-sm">
            <p role="status" className="text-emerald-400">Plantilla «{save.data.name}» creada.</p>
            <DialogFooter>
              <Button asChild variant="secondary"><Link to="/templates">Ver plantillas</Link></Button>
              <Button type="button" onClick={() => setOpen(false)}>Cerrar</Button>
            </DialogFooter>
          </div>
        ) : (
          <form className="flex flex-col gap-3" onSubmit={dialogSubmit(() => save.mutate())}>
            <Field id="stpl-name" label="Nombre"><Input id="stpl-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} /></Field>
            <Field id="stpl-desc" label="Descripción (opcional)"><Textarea id="stpl-desc" rows={3} maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
            {save.error && <p role="alert" className="text-sm text-red-400">{save.error instanceof ApiError ? save.error.message : "Error inesperado"}</p>}
            <DialogFooter><Button type="submit" disabled={save.isPending || !name.trim()}>{save.isPending ? "Guardando…" : "Guardar plantilla"}</Button></DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
