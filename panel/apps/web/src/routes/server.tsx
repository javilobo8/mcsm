import { useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Trash2 } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { StateBadge } from "@/components/state-badge";
import { BackupsTab } from "@/components/backups-tab";
import { JobList } from "@/components/job-list";
import { PowerButtons } from "@/components/power-buttons";
import { Console } from "@/components/console";
import { ServerConfigForm } from "@/components/server-config-form";
import { useServer } from "@/hooks/use-servers";
import { useNodes } from "@/hooks/use-nodes";
import { api, apiPath, ApiError } from "@/lib/api";
import { formatUptime } from "@/lib/format";

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return <Card><CardContent className="p-4"><div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div><div className="mt-1 text-lg">{value}</div></CardContent></Card>;
}

export function ServerPage() {
  const { serverId } = useParams({ from: "/app/servers/$serverId" });
  const q = useServer(serverId);
  const nodes = useNodes();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [confirmDel, setConfirmDel] = useState(false);
  const [deleteData, setDeleteData] = useState(false);
  const del = useMutation({
    mutationFn: () => api.del(apiPath`/api/servers/${serverId}?deleteData=${deleteData}`),
    onSuccess: () => {
      void navigate({ to: "/" }).then(() => {
        qc.removeQueries({ queryKey: ["server", serverId] });
        void qc.invalidateQueries({ queryKey: ["servers"] });
      });
    },
  });

  if (q.isPending) return <div className="flex items-center gap-2 p-6 text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Cargando…</div>;
  if (q.isError || !q.data) {
    const notFound = q.error instanceof ApiError && q.error.status === 404;
    return (
      <div role="alert" className="flex flex-col items-start gap-2 p-6 text-red-400">
        <p>{notFound ? "Servidor no encontrado" : `No se pudo cargar el servidor: ${q.error?.message ?? "error desconocido"}`}</p>
        {!notFound && <Button variant="secondary" size="sm" onClick={() => void q.refetch()}>Reintentar</Button>}
      </div>
    );
  }
  const s = q.data;
  const o = s.observed;
  const node = nodes.data?.find((n) => n.id === s.nodeId);
  const nodeOnline = nodes.data ? node?.status === "online" : undefined;
  const applying = s.specVersion !== s.observedSpecVersion;

  return (
    <div className="flex flex-col gap-4 p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{s.name}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <StateBadge observed={o} desired={s.desiredState} nodeOnline={nodeOnline} />
            <span>{node?.name ?? "—"} · puerto {s.spec.ports.game} · {s.spec.type} {s.spec.version} · {s.spec.memory}</span>
            {applying && nodeOnline !== false && <span role="status" className="flex items-center gap-1 text-amber-400"><Loader2 className="size-3 animate-spin" /> Aplicando v{s.specVersion}… (actual v{s.observedSpecVersion})</span>}
            {applying && nodeOnline === false && <span className="text-amber-400">v{s.specVersion} pendiente: se aplicará al volver el nodo</span>}
          </div>
          {nodeOnline === false && <p className="mt-2 text-sm text-amber-400">El nodo «{node?.name}» está desconectado: el estado mostrado puede estar desfasado y las acciones no están disponibles.</p>}
          {o?.error && <p className="mt-2 max-w-3xl rounded-md border border-red-900 bg-red-950/40 p-2 text-sm text-red-300">{o.error}</p>}
        </div>
        <div className="flex items-center gap-2">
          <PowerButtons server={s} size="default" nodeOnline={nodeOnline} />
          <Button variant="ghost" aria-label={`Eliminar ${s.name}`} title="Eliminar servidor" onClick={() => { del.reset(); setDeleteData(false); setConfirmDel(true); }}><Trash2 className="size-4" /></Button>
        </div>
      </header>

      <Tabs defaultValue="overview">
        <TabsList><TabsTrigger value="overview">Resumen</TabsTrigger><TabsTrigger value="console">Consola</TabsTrigger><TabsTrigger value="config">Configuración</TabsTrigger>
          {/* ── plan-2 ── */}
          {/* ── plan-3 ── */}
          {/* ── plan-4 ── */}
          <TabsTrigger value="backups">Backups</TabsTrigger>
          <TabsTrigger value="history">Historial</TabsTrigger>
          {/* ── plan-5 ── */}
          {/* ── plan-6 ── */}
          {/* ── plan-7 ── */}
          {/* ── plan-8 ── */}
          {/* ── plan-9 ── */}
        </TabsList>
        <TabsContent value="overview" className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Jugadores" value={o?.mc.online ? `${o.mc.playersOnline} / ${o.mc.playersMax}` : "—"} />
          <Stat label="Versión detectada" value={o?.mc.version || "—"} />
          <Stat label="Tiempo encendido" value={o?.state === "running" ? formatUptime(o.startedAtUnix) : "—"} />
          <Stat label="Latencia" value={o?.mc.online ? `${o.mc.latencyMs} ms` : "—"} />
          <Stat label="Contenedor" value={<code className="text-sm">{o?.containerId ? o.containerId.slice(0, 12) : "—"}</code>} />
          <Stat label="Healthcheck" value={o?.health || "—"} />
          <Stat label="Último exit code" value={o && o.state !== "running" ? o.exitCode : "—"} />
          <Stat label="Spec" value={applying ? `v${s.specVersion} (aplicando; actual v${s.observedSpecVersion})` : `v${s.specVersion} (aplicada)`} />
        </TabsContent>
        <TabsContent value="console"><Console key={s.id} serverId={s.id} nodeOnline={nodeOnline} /></TabsContent>
        <TabsContent value="config"><ServerConfigForm key={s.id} server={s} /></TabsContent>
        {/* ── plan-2 ── */}
        {/* ── plan-3 ── */}
        {/* ── plan-4 ── */}
        <TabsContent value="backups"><BackupsTab server={s} nodeOnline={nodeOnline} /></TabsContent>
        <TabsContent value="history"><JobList filter={{ serverId: s.id }} showServer={false} /></TabsContent>
        {/* ── plan-5 ── */}
        {/* ── plan-6 ── */}
        {/* ── plan-7 ── */}
        {/* ── plan-8 ── */}
        {/* ── plan-9 ── */}
      </Tabs>

      <Dialog open={confirmDel} onOpenChange={(o) => { if (!del.isPending) setConfirmDel(o); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Eliminar «{s.name}»</DialogTitle>
            <DialogDescription>El servidor se quitará del panel y su contenedor se eliminará.</DialogDescription>
          </DialogHeader>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={deleteData} onChange={(e) => setDeleteData(e.target.checked)} />
            <span>Borrar también el mundo y los archivos de «{s.name}» en el nodo. Esta acción no se puede deshacer.</span>
          </label>
          {del.error && <p role="alert" className="text-sm text-red-400">{del.error instanceof ApiError ? del.error.message : "Error inesperado"}</p>}
          <DialogFooter>
            <Button variant="ghost" disabled={del.isPending} onClick={() => setConfirmDel(false)}>Cancelar</Button>
            <Button variant="destructive" disabled={del.isPending} onClick={() => del.mutate()}>{del.isPending ? "Eliminando…" : deleteData ? "Eliminar con datos" : "Eliminar"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
