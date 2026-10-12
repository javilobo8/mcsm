import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { api, ApiError } from "@/lib/api";
import { dialogSubmit } from "@/lib/dialog-form";

interface KeyStatus { configured: boolean }

/** Estado de la API key global de CurseForge y diálogo para cambiarla. La key nunca se lee de vuelta. */
export function CurseForgeKeyNotice() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["settings", "curseforge"], queryFn: () => api.get<KeyStatus>("/api/settings/curseforge") });
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const save = useMutation({
    mutationFn: (apiKey: string) => api.put<KeyStatus>("/api/settings/curseforge", { apiKey }),
    onSuccess: (s) => {
      qc.setQueryData(["settings", "curseforge"], s);
      void qc.invalidateQueries({ queryKey: ["servers"] });
      setOpen(false); setKey("");
    },
  });
  const configured = status.data?.configured;
  const removeKey = () => {
    if (window.confirm("Quitar la API key de CurseForge recreará los servidores de CurseForge que estén en marcha. ¿Continuar?")) save.mutate("");
  };
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2 text-xs">
      <KeyRound className="size-4 text-muted-foreground" />
      <span>
        API key de CurseForge: {status.isError ? <strong role="alert" className="text-red-400">no se pudo consultar</strong> : configured === undefined ? "…" : configured ? <strong className="text-emerald-400">configurada</strong> : <strong className="text-amber-400">sin configurar</strong>}
        {configured === false && " (las imágenes java17 o superiores traen una; con java8 es obligatoria)"}
      </span>
      <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) { setKey(""); save.reset(); } }}>
        <DialogTrigger asChild><Button type="button" size="sm" variant="secondary">{configured ? "Cambiar" : "Configurar"}</Button></DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>API key de CurseForge</DialogTitle>
            <DialogDescription>Es global para todos los servidores. Al cambiarla se recrean los que descargan de CurseForge.</DialogDescription>
          </DialogHeader>
          <form className="flex flex-col gap-3" onSubmit={dialogSubmit(() => save.mutate(key.trim()))}>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cf-api-key">Nueva API key</Label>
              <Input id="cf-api-key" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder="$2a$10$…" />
              <p className="text-xs text-muted-foreground">Se obtiene en console.curseforge.com. Pégala tal cual: los «$» no se escapan.</p>
            </div>
            {save.error && <p role="alert" className="text-sm text-red-400">{save.error instanceof ApiError ? save.error.message : "Error inesperado"}</p>}
            <DialogFooter>
              {configured && <Button type="button" variant="ghost" disabled={save.isPending} onClick={removeKey}>Quitar la key</Button>}
              <Button type="submit" disabled={save.isPending || key.trim() === ""}>{save.isPending ? "Guardando…" : "Guardar"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
