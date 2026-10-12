import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { RouterDto } from "@mcsm/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import type { NodeDto } from "@/lib/api";
import { dialogSubmit } from "@/lib/dialog-form";
import { routerFormBody, routerFormErrors, routerFormFrom, routerKey, routerStatus, type RouterStatus } from "@/lib/router";
import { saveRouter, useNodeRouter } from "@/hooks/use-router";

const tones = {
  ok: "bg-emerald-600/20 text-emerald-300 border-emerald-700",
  warn: "bg-amber-600/20 text-amber-300 border-amber-700",
  bad: "bg-red-600/20 text-red-300 border-red-700",
  muted: "bg-zinc-800 text-zinc-400 border-zinc-700",
};

export function RouterBadge({ status }: { status: RouterStatus }) {
  return <Badge variant="outline" className={tones[status.tone]} title={status.detail ?? undefined}>{status.label}</Badge>;
}

/** Formulario del router de un nodo (dentro del diálogo). Exportado para los tests. */
export function NodeRouterForm({ node, router, onSaved }: { node: NodeDto; router: RouterDto; onSaved: (r: RouterDto) => void }) {
  const [form, setForm] = useState(() => routerFormFrom(router.spec));
  const errors = routerFormErrors(form);
  const invalid = Object.keys(errors).length > 0;
  const status = routerStatus(router, node.status === "online");
  const save = useMutation({ mutationFn: () => saveRouter(node.id, routerFormBody(form, router.spec)), onSuccess: onSaved });
  return (
    <form className="flex flex-col gap-4" onSubmit={dialogSubmit(() => { if (!invalid) save.mutate(); })}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-zinc-400">Estado:</span> <RouterBadge status={status} />
        {router.observed?.image && <span className="font-mono text-xs text-zinc-500">{router.observed.image}</span>}
      </div>
      {status.detail && <p role="alert" className="text-xs text-red-400">{status.detail}</p>}
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" className="size-4 accent-emerald-500" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
        Activar el router en este nodo
      </label>
      <div className="flex max-w-xs flex-col gap-1.5">
        <Label htmlFor="router-port">Puerto del host</Label>
        <Input id="router-port" inputMode="numeric" value={form.port} aria-invalid={!!errors.port} onChange={(e) => setForm({ ...form, port: e.target.value })} />
        {errors.port
          ? <p role="alert" className="text-xs text-red-400">{errors.port}</p>
          : <p className="text-xs text-muted-foreground">25565 es el puerto por defecto de Minecraft: así los jugadores no escriben puerto. Ningún servidor del nodo puede publicarlo.</p>}
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" className="size-4 accent-emerald-500" checked={form.autoscale} onChange={(e) => setForm({ ...form, autoscale: e.target.checked })} />
        Autoscale: arrancar al entrar un jugador y parar sin jugadores
      </label>
      {form.autoscale && (
        <div className="flex max-w-xs flex-col gap-1.5">
          <Label htmlFor="router-minutes">Minutos sin jugadores hasta parar</Label>
          <Input id="router-minutes" inputMode="numeric" value={form.minutes} aria-invalid={!!errors.minutes} onChange={(e) => setForm({ ...form, minutes: e.target.value })} />
          {errors.minutes && <p role="alert" className="text-xs text-red-400">{errors.minutes}</p>}
          <p className="text-xs text-muted-foreground">
            Los servidores con hostname quedan bajo demanda: mc-router los arranca cuando alguien intenta entrar y los para tras esos minutos sin jugadores; el panel deja de arrancarlos y pararlos por su cuenta. Parar desde el panel no impide que un jugador lo vuelva a arrancar al entrar. Al recrearse (cambio de configuración, restauración, copia en frío) un servidor dormido arranca y mc-router lo vuelve a dormir tras esos minutos sin jugadores.
          </p>
        </div>
      )}
      {form.autoscale && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="router-players">Jugadores que pueden despertar servidores</Label>
          <Textarea id="router-players" rows={3} value={form.players} aria-invalid={!!errors.players} placeholder="Uno por línea (nombre o UUID)"
            onChange={(e) => setForm({ ...form, players: e.target.value })} />
          {errors.players
            ? <p role="alert" className="text-xs text-red-400">{errors.players}</p>
            : <p className="text-xs text-muted-foreground">Vacío: cualquiera que llegue al puerto del router despierta los servidores dormidos (y con varios a la vez, el nodo se puede quedar sin memoria). Cambiar la lista reinicia el router: los jugadores conectados por él se desconectan.</p>}
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        El router (itzg/mc-router) usa el socket de Docker del nodo para encontrar los servidores con hostname (y, con autoscale, arrancarlos y pararlos): tiene control total de Docker en esa máquina, lo que equivale a root, y montarlo en solo lectura no lo limita. Va endurecido y con la imagen fijada, pero actívalo solo en nodos de confianza. Si el socket no da acceso a su grupo (o Docker funciona en modo rootless) el router no verá los servidores. Los jugadores entran por el hostname de cada servidor (Configuración → Red) con un DNS local que apunte a esta máquina; cada servidor sigue teniendo también su puerto propio.
      </p>
      <Button type="submit" disabled={save.isPending || invalid}>{save.isPending ? "Guardando…" : "Guardar"}</Button>
      {save.error && <p role="alert" className="text-sm text-red-400">{save.error.message}</p>}
    </form>
  );
}

/** Celda de la tabla de Nodos: estado del router y diálogo para configurarlo. */
export function NodeRouterCell({ node }: { node: NodeDto }) {
  const router = useNodeRouter(node.id);
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  if (router.isPending) return <span className="text-xs text-zinc-400">…</span>;
  if (router.isError) return <span role="alert" className="text-xs text-red-400" title={router.error.message}>Error</span>;
  const status = routerStatus(router.data, node.status === "online");
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" aria-label={`Router del nodo ${node.name}: ${status.label}`}><RouterBadge status={status} /></Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Router de «{node.name}»</DialogTitle>
          <DialogDescription>mc-router: entrada de jugadores por hostname en un único puerto del nodo.</DialogDescription>
        </DialogHeader>
        {open && <NodeRouterForm node={node} router={router.data} onSaved={(r) => { qc.setQueryData(routerKey(node.id), r); setOpen(false); }} />}
      </DialogContent>
    </Dialog>
  );
}
