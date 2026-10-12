import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Check, Copy, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { api, apiPath } from "@/lib/api";
import { dialogSubmit } from "@/lib/dialog-form";
import { validateDataRoot } from "@/lib/nodes";
import { useNodes } from "@/hooks/use-nodes";
import { NodeRouterCell } from "@/components/node-router";

interface EnrollResp { token: string; expiresAt: string; dockerRun: string }

export function NodesPage() {
  const nodes = useNodes();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [nameHint, setNameHint] = useState("");
  const [dataRoot, setDataRoot] = useState("/srv/minecraft");
  const [result, setResult] = useState<EnrollResp | null>(null);
  const [copied, setCopied] = useState<"ok" | "fail" | null>(null);

  const openRef = useRef(false);
  openRef.current = open;
  const rootError = validateDataRoot(dataRoot);
  const gen = useMutation({
    mutationFn: () => api.post<EnrollResp>("/api/nodes/enrollment-tokens", { nameHint: nameHint.trim() || "nodo", dataRoot }),
    // Si el diálogo se cerró con la petición en curso, el token no debe reaparecer al reabrir.
    onSuccess: (r) => { if (openRef.current) setResult(r); },
  });
  const del = useMutation({
    mutationFn: (id: string) => api.del(apiPath`/api/nodes/${id}`),
    onSettled: () => { void qc.invalidateQueries({ queryKey: ["nodes"] }); },
  });
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied("ok"); } catch { setCopied("fail"); }
  };

  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Nodos</h1>
        <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) { setResult(null); setCopied(null); gen.reset(); } }}>
          <DialogTrigger asChild><Button>Añadir nodo</Button></DialogTrigger>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Añadir nodo</DialogTitle>
              <DialogDescription>Genera un comando de alta de un solo uso para la máquina nueva.</DialogDescription>
            </DialogHeader>
            {!result ? (
              <form className="flex flex-col gap-3" onSubmit={dialogSubmit(() => { if (!rootError) gen.mutate(); })}>
                <div className="flex flex-col gap-1.5"><Label htmlFor="node-name">Nombre</Label><Input id="node-name" value={nameHint} onChange={(e) => setNameHint(e.target.value)} placeholder="nas, salon, torre…" maxLength={40} />{!nameHint.trim() && <p className="text-xs text-amber-400">Sin nombre se usará «nodo»; elige uno distinto si ya tienes otros nodos.</p>}</div>
                <div className="flex flex-col gap-1.5"><Label htmlFor="node-root">Directorio de datos en esa máquina</Label><Input id="node-root" value={dataRoot} onChange={(e) => setDataRoot(e.target.value)} className="font-mono" aria-invalid={!!rootError} />{rootError ? <p role="alert" className="text-xs text-red-400">{rootError}</p> : <p className="text-xs text-muted-foreground">Ruta absoluta; se monta con la misma ruta dentro del agente.</p>}</div>
                <Button type="submit" disabled={gen.isPending || !!rootError}>{gen.isPending ? "Generando…" : "Generar comando"}</Button>
                {gen.error && <p role="alert" className="text-sm text-red-400">{gen.error.message}</p>}
              </form>
            ) : (
              <div className="flex flex-col gap-3">
                <p className="text-sm text-zinc-400">Ejecuta esto en la máquina nueva. El token caduca a las {new Date(result.expiresAt).toLocaleTimeString()} y solo sirve una vez. El nodo aparecerá aquí en cuanto conecte.</p>
                <pre data-testid="docker-run" className="overflow-x-auto rounded-md bg-zinc-900 p-3 text-xs">{result.dockerRun}</pre>
                <Button variant="secondary" onClick={() => void copy(result.dockerRun)}>
                  {copied === "ok" ? <Check className="size-4" /> : <Copy className="size-4" />} {copied === "ok" ? "Copiado" : "Copiar"}
                </Button>
                {copied === "fail" && <p role="alert" className="text-sm text-amber-400">No se pudo copiar automáticamente; selecciona el texto a mano.</p>}
              </div>
            )}
          </DialogContent>
        </Dialog>
      </div>

      {nodes.isError && <p role="alert" className="text-sm text-red-400">No se pudieron cargar los nodos: {nodes.error.message}</p>}
      <Table>
        <TableHeader><TableRow><TableHead>Nombre</TableHead><TableHead>Estado</TableHead><TableHead>Router</TableHead><TableHead>Agente</TableHead><TableHead>Docker</TableHead><TableHead>Host</TableHead><TableHead>Datos</TableHead><TableHead>Última vez</TableHead><TableHead><span className="sr-only">Acciones</span></TableHead></TableRow></TableHeader>
        <TableBody>
          {nodes.isPending && <TableRow><TableCell colSpan={9} className="text-center text-zinc-400">Cargando nodos…</TableCell></TableRow>}
          {nodes.data?.length === 0 && <TableRow><TableCell colSpan={9} className="text-center text-zinc-400">No hay nodos. Pulsa «Añadir nodo» para dar de alta el primero.</TableCell></TableRow>}
          {nodes.data?.map((n) => (
            <TableRow key={n.id}>
              <TableCell className="font-medium">{n.name}</TableCell>
              <TableCell><Badge variant="outline" className={n.status === "online" ? "border-emerald-700 text-emerald-300" : "border-zinc-700 text-zinc-400"}>{n.status === "online" ? "Conectado" : "Desconectado"}</Badge></TableCell>
              <TableCell><NodeRouterCell node={n} /></TableCell>
              <TableCell>{n.agentVersion ?? "—"}</TableCell>
              <TableCell>{n.dockerVersion ?? "—"}</TableCell>
              <TableCell className="text-xs text-zinc-400">{n.hostInfo?.hostname ? `${n.hostInfo.hostname} · ${n.hostInfo.os ?? "?"}/${n.hostInfo.arch ?? "?"}` : "—"}</TableCell>
              <TableCell className="font-mono text-xs">{n.dataRoot}</TableCell>
              <TableCell className="text-xs text-zinc-400">{n.lastSeenAt ? new Date(n.lastSeenAt).toLocaleString() : "nunca"}</TableCell>
              <TableCell>
                <div className="flex items-center justify-end gap-1">
                  {/* plan-6: Nodos → Importar */}
                  <Button size="sm" variant="secondary" asChild><Link to="/nodes/$nodeId/import" params={{ nodeId: n.id }}>Importar</Link></Button>
                  <Button size="sm" variant="ghost" aria-label={`Eliminar nodo ${n.name}`} title="Eliminar" disabled={del.isPending} onClick={() => { if (confirm(`¿Eliminar el nodo "${n.name}"? Solo es posible si no tiene servidores. Si participa en una migración a medias, el panel la olvida: si el nodo solo está aislado de la red, la copia del servidor puede seguir en marcha allí; compruébalo antes de arrancar el servidor en su nodo de origen.`)) del.mutate(n.id); }}><Trash2 className="size-4" /></Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {del.error && <p role="alert" className="text-sm text-red-400">{del.error.message}</p>}
    </div>
  );
}
