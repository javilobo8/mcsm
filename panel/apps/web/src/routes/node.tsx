import { useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { NodeUsage } from "@/components/node-usage";
import { NodeRouterCell } from "@/components/node-router";
import { NodeCharts } from "@/components/node-charts";
import { StateBadge } from "@/components/state-badge";
import { PAGE, PageHeader, SectionTitle } from "@/components/page-header";
import { StatusBadge } from "@/components/status";
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
    onSuccess: (n) => { setConfirm(false); mergeIntoCached<NodeDto[]>(qc, ["nodes"], (old) => old.map((x) => (x.id === n.id ? { ...x, tokenRotationPending: n.tokenRotationPending } : x))); }, // only what changed: the response row may lag behind the live state
  });
  const n = nodes.data?.find((x) => x.id === nodeId);
  if (nodes.isPending) return <p className="p-4 sm:p-6 lg:p-8 text-muted-foreground">Loading node…</p>;
  if (!n) return <p role="alert" className="p-4 sm:p-6 lg:p-8 text-bad">Node not found</p>;
  const online = n.status === "online";
  const mine = servers.data?.filter((s) => s.nodeId === n.id) ?? [];
  const note = rotationNote(n);
  return (
    <div className={PAGE}>
      <PageHeader
        title={n.name}
        description={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge tone={online ? "ok" : "muted"}>{online ? "Online" : "Offline"}</StatusBadge>
            <span>Agent {n.agentVersion ?? "—"} · Docker {n.dockerVersion ?? "—"} · {hostLabel(n)}</span>
            <span className="font-mono text-xs">{n.dataRoot}</span>
          </div>
        }
        actions={
          <>
            <Button variant="secondary" asChild><Link to="/nodes/$nodeId/import" params={{ nodeId: n.id }}>Import</Link></Button>
            <Button variant="outline" disabled={!online || rotate.isPending} title={online ? undefined : "The node is offline"} onClick={() => { rotate.reset(); setConfirm(true); }}><KeyRound className="size-4" /> Rotate token</Button>
          </>
        }
      >
        {note && <p role="status" className="mt-2 text-sm text-warn">{note}</p>}
      </PageHeader>
      {rotate.isSuccess && <p role="status" className="text-sm text-ok">Token rotated: the agent reconnects with the new one and the previous one stops being valid as soon as it does.</p>}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Card className="py-0"><CardContent className="p-4"><NodeUsage nodeId={n.id} /></CardContent></Card>
        <Card className="py-0"><CardContent className="flex items-center gap-2 p-4 text-sm">Router: <NodeRouterCell node={n} /></CardContent></Card>
      </div>
      <NodeCharts key={n.id} nodeId={n.id} />
      <section aria-label="Node servers" className="flex flex-col gap-3">
        <SectionTitle>Servers</SectionTitle>
        {mine.length === 0 && <p className="text-sm text-muted-foreground">No servers on this node.</p>}
        {mine.length > 0 && (
          <ul className="flex flex-col divide-y divide-cobble/70 rounded-lg border border-cobble bg-bedrock/70">
            {mine.map((s) => (
              <li key={s.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <StateBadge observed={s.observed} desired={s.desiredState} nodeOnline={online} />
                <Link to="/servers/$serverId" params={{ serverId: s.id }} className="font-medium text-bone hover:underline">{s.name}</Link>
                <span className="ml-auto text-muted-foreground">port {s.spec.ports.game}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <ConfirmDialog open={confirm} title={`Rotate the token of “${n.name}”`}
        description="The agent receives a new token, stores it and reconnects with it; the previous one stops being valid when it does. It is useful for renewing it periodically. If you suspect the token has leaked, rotating it is not enough (whoever has it could receive the new one): delete the node and enroll it again."
        confirmLabel="Rotate token" pending={rotate.isPending} error={rotate.error ? (rotate.error instanceof ApiError ? rotate.error.message : "Unexpected error") : null}
        onConfirm={() => rotate.mutate()} onCancel={() => setConfirm(false)} />
    </div>
  );
}
