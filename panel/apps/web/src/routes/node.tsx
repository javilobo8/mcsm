import { useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { NodeUsage } from "@/components/node-usage";
import { NodeRouterCell } from "@/components/node-router";
import { NodeCharts } from "@/components/node-charts";
import { StateBadge } from "@/components/state-badge";
import { useNodes } from "@/hooks/use-nodes";
import { useServers } from "@/hooks/use-servers";
import { api, apiPath, ApiError, type NodeDto } from "@/lib/api";
import { mergeIntoCached } from "@/lib/live";
import { hostLabel, rotationNote } from "@/lib/node-detail";

export function NodeDetailPage() {
  const { nodeId } = useParams({ from: "/app/nodes/$nodeId" });
  const nodes = useNodes();
  const servers = useServers();
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const rotate = useMutation({
    mutationFn: () => api.post<NodeDto>(apiPath`/api/nodes/${nodeId}/rotate-token`),
    onSuccess: (n) => { setConfirm(false); mergeIntoCached<NodeDto[]>(qc, ["nodes"], (old) => old.map((x) => (x.id === n.id ? { ...x, tokenRotationPending: n.tokenRotationPending } : x))); }, // solo lo que cambió: la fila de la respuesta puede ir por detrás del estado en vivo
  });
  const n = nodes.data?.find((x) => x.id === nodeId);
  if (nodes.isPending) return <p className="p-6 text-muted-foreground">Cargando nodo…</p>;
  if (!n) return <p role="alert" className="p-6 text-red-400">Nodo no encontrado</p>;
  const online = n.status === "online";
  const mine = servers.data?.filter((s) => s.nodeId === n.id) ?? [];
  const note = rotationNote(n);
  return (
    <div className="flex flex-col gap-4 p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{n.name}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <Badge variant="outline" className={online ? "border-emerald-700 text-emerald-300" : "border-zinc-700 text-zinc-400"}>{online ? "Conectado" : "Desconectado"}</Badge>
            <span>Agente {n.agentVersion ?? "—"} · Docker {n.dockerVersion ?? "—"} · {hostLabel(n)}</span>
            <span className="font-mono text-xs">{n.dataRoot}</span>
          </div>
          {note && <p role="status" className="mt-2 text-sm text-amber-400">{note}</p>}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" asChild><Link to="/nodes/$nodeId/import" params={{ nodeId: n.id }}>Importar</Link></Button>
          <Button variant="outline" disabled={!online || rotate.isPending} title={online ? undefined : "El nodo está desconectado"} onClick={() => { rotate.reset(); setConfirm(true); }}><KeyRound className="size-4" /> Rotar token</Button>
        </div>
      </header>
      {rotate.isSuccess && <p role="status" className="text-sm text-emerald-400">Token rotado: el agente se reconecta con el nuevo y el anterior deja de valer en cuanto lo haga.</p>}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Card><CardContent className="p-4"><NodeUsage nodeId={n.id} /></CardContent></Card>
        <Card><CardContent className="flex items-center gap-2 p-4 text-sm">Router: <NodeRouterCell node={n} /></CardContent></Card>
      </div>
      <NodeCharts key={n.id} nodeId={n.id} />
      <section aria-label="Servidores del nodo" className="flex flex-col gap-2">
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">Servidores</h2>
        {mine.length === 0 && <p className="text-sm text-muted-foreground">Ningún servidor en este nodo.</p>}
        <ul className="flex flex-col gap-1">
          {mine.map((s) => (
            <li key={s.id} className="flex items-center gap-2 text-sm">
              <StateBadge observed={s.observed} desired={s.desiredState} nodeOnline={online} />
              <Link to="/servers/$serverId" params={{ serverId: s.id }} className="hover:underline">{s.name}</Link>
              <span className="text-muted-foreground">puerto {s.spec.ports.game}</span>
            </li>
          ))}
        </ul>
      </section>
      <ConfirmDialog open={confirm} title={`Rotar el token de «${n.name}»`}
        description="El agente recibe un token nuevo, lo guarda y se reconecta con él; el anterior deja de valer cuando lo haga. Sirve para renovarlo de forma periódica. Si sospechas que el token se ha filtrado, rotarlo no basta (quien lo tenga podría recibir el nuevo): borra el nodo y vuelve a darlo de alta."
        confirmLabel="Rotar token" pending={rotate.isPending} error={rotate.error ? (rotate.error instanceof ApiError ? rotate.error.message : "Error inesperado") : null}
        onConfirm={() => rotate.mutate()} onCancel={() => setConfirm(false)} />
    </div>
  );
}
