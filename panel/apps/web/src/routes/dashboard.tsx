import { Link } from "@tanstack/react-router";
import { Users, Cpu, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PAGE, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status";
import { StateBadge } from "@/components/state-badge";
import { PowerButtons } from "@/components/power-buttons";
import { useServers } from "@/hooks/use-servers";
import { useNodes } from "@/hooks/use-nodes";
import { NodeUsage } from "@/components/node-usage";
import { ServerAddress } from "@/components/server-address";
import { useSettings } from "@/hooks/use-settings";
import { cn } from "@/lib/utils";
import { fleetSummary, formatBytes } from "@/lib/format";

const panel = "rounded-lg border border-cobble bg-bedrock/70";

export function DashboardPage() {
  const servers = useServers();
  const nodes = useNodes();
  const settings = useSettings();
  const nodeName = (id: string) => nodes.data?.find((n) => n.id === id)?.name ?? "—";
  const nodeOnline = (id: string): boolean | undefined => { const n = nodes.data?.find((x) => x.id === id); return n ? n.status === "online" : undefined; };

  return (
    <section aria-label="Servers" className={PAGE}>
      <PageHeader
        title="Servers"
        description={servers.data && nodes.data ? fleetSummary(servers.data, nodes.data) : undefined}
        actions={<Button asChild><Link to="/servers/new"><Plus className="size-4" /> New server</Link></Button>}
      />

      <section aria-label="Nodes" className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {nodes.isPending && <div className={cn(panel, "p-4 text-sm text-muted-foreground")}>Loading nodes…</div>}
        {nodes.isError && <div role="alert" className={cn(panel, "p-4 text-sm text-bad")}>Could not load the nodes: {nodes.error.message}</div>}
        {nodes.data?.map((n) => {
          const online = n.status === "online";
          return (
            <div key={n.id} className={cn(panel, "flex flex-col gap-3 p-4", !online && "opacity-70")}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <Link to="/nodes/$nodeId" params={{ nodeId: n.id }} className="block truncate font-medium text-bone hover:underline">{n.name}</Link>
                  <div className="mt-0.5 text-xs text-muted-foreground">Agent {n.agentVersion ?? "?"} · Docker {n.dockerVersion ?? "?"}</div>
                </div>
                <StatusBadge tone={online ? "ok" : "muted"}>{online ? "Online" : "Offline"}</StatusBadge>
              </div>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Cpu className="size-3" aria-hidden="true" /> {n.hostInfo?.cpus ?? "?"} CPU · {formatBytes(n.hostInfo?.memTotalBytes ?? 0)}
              </div>
              {online && <NodeUsage nodeId={n.id} />}
            </div>
          );
        })}
        {nodes.data?.length === 0 && <div className={cn(panel, "p-4 text-sm text-muted-foreground")}>No nodes yet. <Link to="/nodes" className="text-grass-bright hover:underline">Add the first one</Link>.</div>}
      </section>

      {servers.isError && <p role="alert" className="text-sm text-bad">Could not load the servers: {servers.error.message}</p>}
      <Table>
        <TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Status</TableHead><TableHead>Players</TableHead><TableHead>Version</TableHead><TableHead>Node</TableHead><TableHead>Address</TableHead><TableHead><span className="sr-only">Actions</span></TableHead></TableRow></TableHeader>
        <TableBody>
          {servers.isPending && <TableRow><TableCell colSpan={7} className="py-6 text-center text-muted-foreground">Loading servers…</TableCell></TableRow>}
          {servers.data?.map((s) => (
            <TableRow key={s.id} data-testid={`server-row-${s.slug}`}>
              <TableCell><Link to="/servers/$serverId" params={{ serverId: s.id }} className="font-medium text-bone hover:underline">{s.name}</Link><div className="text-xs text-muted-foreground">{s.slug}</div></TableCell>
              <TableCell>
                <StateBadge observed={s.observed} desired={s.desiredState} nodeOnline={nodeOnline(s.nodeId)} />
                {s.observedSpecVersion !== s.specVersion && <span className="ml-2 text-xs text-warn">applying v{s.specVersion}…</span>}
              </TableCell>
              <TableCell>{s.observed?.mc.online ? <span className="flex items-center gap-1 tabular-nums"><Users className="size-3 text-muted-foreground" /> {s.observed.mc.playersOnline}/{s.observed.mc.playersMax}</span> : <span className="text-muted-foreground">—</span>}</TableCell>
              <TableCell>{s.observed?.mc.version || `${s.spec.type} ${s.spec.version}`}</TableCell>
              <TableCell>{nodeName(s.nodeId)}</TableCell>
              <TableCell><ServerAddress server={s} connect={settings.data?.connectAddress} /></TableCell>
              <TableCell><PowerButtons server={s} nodeOnline={nodeOnline(s.nodeId)} /></TableCell>
            </TableRow>
          ))}
          {servers.data?.length === 0 && <TableRow><TableCell colSpan={7} className="py-6 text-center text-muted-foreground">No servers. <Link to="/servers/new" className="text-grass-bright hover:underline">Create the first one</Link>.</TableCell></TableRow>}
        </TableBody>
      </Table>
    </section>
  );
}
