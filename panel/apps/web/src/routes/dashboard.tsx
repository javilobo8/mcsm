import { Link } from "@tanstack/react-router";
import { Users, Cpu, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StateBadge } from "@/components/state-badge";
import { PowerButtons } from "@/components/power-buttons";
import { useServers } from "@/hooks/use-servers";
import { useNodes } from "@/hooks/use-nodes";
import { NodeUsage } from "@/components/node-usage";
import { ServerAddress } from "@/components/server-address";
import { useSettings } from "@/hooks/use-settings";
import { formatBytes } from "@/lib/format";

export function DashboardPage() {
  const servers = useServers();
  const nodes = useNodes();
  const settings = useSettings();
  const nodeName = (id: string) => nodes.data?.find((n) => n.id === id)?.name ?? "—";
  const nodeOnline = (id: string): boolean | undefined => { const n = nodes.data?.find((x) => x.id === id); return n ? n.status === "online" : undefined; };

  return (
    <div className="flex flex-col gap-6 p-6">
      <section aria-label="Nodes" className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {nodes.isPending && <Card><CardContent className="p-4 text-sm text-muted-foreground">Loading nodes…</CardContent></Card>}
        {nodes.isError && <Card><CardContent role="alert" className="p-4 text-sm text-red-400">Could not load the nodes: {nodes.error.message}</CardContent></Card>}
        {nodes.data?.map((n) => (
          <Card key={n.id} className={n.status === "online" ? "border-emerald-900" : "border-zinc-800 opacity-70"}>
            <CardContent className="flex flex-col gap-3 p-4">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate font-medium">{n.name}</div>
                  <div className="text-xs text-zinc-400">{n.status === "online" ? `Agent ${n.agentVersion ?? "?"} · Docker ${n.dockerVersion ?? "?"}` : "Offline"}</div>
                </div>
                <div className="flex shrink-0 items-center gap-1 text-xs text-zinc-400"><Cpu className="size-3" /> {n.hostInfo?.cpus ?? "?"} CPU · {formatBytes(n.hostInfo?.memTotalBytes ?? 0)}</div>
              </div>
              {n.status === "online" && <NodeUsage nodeId={n.id} />}
            </CardContent>
          </Card>
        ))}
        {nodes.data?.length === 0 && <Card><CardContent className="p-4 text-sm text-zinc-400">No nodes yet. <Link to="/nodes" className="underline">Add the first one</Link>.</CardContent></Card>}
      </section>

      <section aria-label="Servers">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-400">Servers</h2>
          <Button size="sm" asChild><Link to="/servers/new"><Plus className="size-4" /> New server</Link></Button>
        </div>
        {servers.isError && <p role="alert" className="mb-2 text-sm text-red-400">Could not load the servers: {servers.error.message}</p>}
        <Table>
          <TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Status</TableHead><TableHead>Players</TableHead><TableHead>Version</TableHead><TableHead>Node</TableHead><TableHead>Address</TableHead><TableHead><span className="sr-only">Actions</span></TableHead></TableRow></TableHeader>
          <TableBody>
            {servers.isPending && <TableRow><TableCell colSpan={7} className="text-center text-zinc-400">Loading servers…</TableCell></TableRow>}
            {servers.data?.map((s) => (
              <TableRow key={s.id} data-testid={`server-row-${s.slug}`}>
                <TableCell><Link to="/servers/$serverId" params={{ serverId: s.id }} className="font-medium hover:underline">{s.name}</Link><div className="text-xs text-zinc-500">{s.slug}</div></TableCell>
                <TableCell>
                  <StateBadge observed={s.observed} desired={s.desiredState} nodeOnline={nodeOnline(s.nodeId)} />
                  {s.observedSpecVersion !== s.specVersion && <span className="ml-2 text-xs text-amber-400">applying v{s.specVersion}…</span>}
                </TableCell>
                <TableCell>{s.observed?.mc.online ? <span className="flex items-center gap-1"><Users className="size-3" /> {s.observed.mc.playersOnline}/{s.observed.mc.playersMax}</span> : <span className="text-zinc-500">—</span>}</TableCell>
                <TableCell>{s.observed?.mc.version || `${s.spec.type} ${s.spec.version}`}</TableCell>
                <TableCell>{nodeName(s.nodeId)}</TableCell>
                <TableCell><ServerAddress server={s} connect={settings.data?.connectAddress} /></TableCell>
                <TableCell><PowerButtons server={s} nodeOnline={nodeOnline(s.nodeId)} /></TableCell>
              </TableRow>
            ))}
            {servers.data?.length === 0 && <TableRow><TableCell colSpan={7} className="text-center text-zinc-400">No servers. <Link to="/servers/new" className="underline">Create the first one</Link>.</TableCell></TableRow>}
          </TableBody>
        </Table>
      </section>
    </div>
  );
}
