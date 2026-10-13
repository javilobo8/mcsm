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
    mutationFn: () => api.post<EnrollResp>("/api/nodes/enrollment-tokens", { nameHint: nameHint.trim() || "node", dataRoot }),
    // If the dialog was closed with the request in flight, the token must not reappear when it is reopened.
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
        <h1 className="text-xl font-semibold">Nodes</h1>
        <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) { setResult(null); setCopied(null); gen.reset(); } }}>
          <DialogTrigger asChild><Button>Add node</Button></DialogTrigger>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Add node</DialogTitle>
              <DialogDescription>Generates a single-use enrollment command for the new machine.</DialogDescription>
            </DialogHeader>
            {!result ? (
              <form className="flex flex-col gap-3" onSubmit={dialogSubmit(() => { if (!rootError) gen.mutate(); })}>
                <div className="flex flex-col gap-1.5"><Label htmlFor="node-name">Name</Label><Input id="node-name" value={nameHint} onChange={(e) => setNameHint(e.target.value)} placeholder="nas, lounge, tower…" maxLength={40} />{!nameHint.trim() && <p className="text-xs text-amber-400">Without a name “node” will be used; choose a different one if you already have other nodes.</p>}</div>
                <div className="flex flex-col gap-1.5"><Label htmlFor="node-root">Data directory on that machine</Label><Input id="node-root" value={dataRoot} onChange={(e) => setDataRoot(e.target.value)} className="font-mono" aria-invalid={!!rootError} />{rootError ? <p role="alert" className="text-xs text-red-400">{rootError}</p> : <p className="text-xs text-muted-foreground">Absolute path; it is mounted at the same path inside the agent.</p>}</div>
                <Button type="submit" disabled={gen.isPending || !!rootError}>{gen.isPending ? "Generating…" : "Generate command"}</Button>
                {gen.error && <p role="alert" className="text-sm text-red-400">{gen.error.message}</p>}
              </form>
            ) : (
              <div className="flex flex-col gap-3">
                <p className="text-sm text-zinc-400">Run this on the new machine. The token expires at {new Date(result.expiresAt).toLocaleTimeString()} and only works once. The node will appear here as soon as it connects.</p>
                <pre data-testid="docker-run" className="overflow-x-auto rounded-md bg-zinc-900 p-3 text-xs">{result.dockerRun}</pre>
                <Button variant="secondary" onClick={() => void copy(result.dockerRun)}>
                  {copied === "ok" ? <Check className="size-4" /> : <Copy className="size-4" />} {copied === "ok" ? "Copied" : "Copy"}
                </Button>
                {copied === "fail" && <p role="alert" className="text-sm text-amber-400">Could not copy automatically; select the text by hand.</p>}
              </div>
            )}
          </DialogContent>
        </Dialog>
      </div>

      {nodes.isError && <p role="alert" className="text-sm text-red-400">Could not load the nodes: {nodes.error.message}</p>}
      <Table>
        <TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Status</TableHead><TableHead>Router</TableHead><TableHead>Agent</TableHead><TableHead>Docker</TableHead><TableHead>Host</TableHead><TableHead>Data</TableHead><TableHead>Last seen</TableHead><TableHead><span className="sr-only">Actions</span></TableHead></TableRow></TableHeader>
        <TableBody>
          {nodes.isPending && <TableRow><TableCell colSpan={9} className="text-center text-zinc-400">Loading nodes…</TableCell></TableRow>}
          {nodes.data?.length === 0 && <TableRow><TableCell colSpan={9} className="text-center text-zinc-400">No nodes. Press “Add node” to enroll the first one.</TableCell></TableRow>}
          {nodes.data?.map((n) => (
            <TableRow key={n.id}>
              <TableCell className="font-medium"><Link to="/nodes/$nodeId" params={{ nodeId: n.id }} className="hover:underline">{n.name}</Link></TableCell>
              <TableCell><Badge variant="outline" className={n.status === "online" ? "border-emerald-700 text-emerald-300" : "border-zinc-700 text-zinc-400"}>{n.status === "online" ? "Online" : "Offline"}</Badge></TableCell>
              <TableCell><NodeRouterCell node={n} /></TableCell>
              <TableCell>{n.agentVersion ?? "—"}</TableCell>
              <TableCell>{n.dockerVersion ?? "—"}</TableCell>
              <TableCell className="text-xs text-zinc-400">{n.hostInfo?.hostname ? `${n.hostInfo.hostname} · ${n.hostInfo.os ?? "?"}/${n.hostInfo.arch ?? "?"}` : "—"}</TableCell>
              <TableCell className="font-mono text-xs">{n.dataRoot}</TableCell>
              <TableCell className="text-xs text-zinc-400">{n.lastSeenAt ? new Date(n.lastSeenAt).toLocaleString() : "never"}</TableCell>
              <TableCell>
                <div className="flex items-center justify-end gap-1">
                  {/* plan-6: Nodes → Import */}
                  <Button size="sm" variant="secondary" asChild><Link to="/nodes/$nodeId/import" params={{ nodeId: n.id }}>Import</Link></Button>
                  <Button size="sm" variant="ghost" aria-label={`Delete node ${n.name}`} title="Delete" disabled={del.isPending} onClick={() => { if (confirm(`Delete the node "${n.name}"? This is only possible if it has no servers. If it takes part in a half-finished migration, the panel forgets it: if the node is only isolated from the network, the server's copy may still be running there; check before starting the server on its source node.`)) del.mutate(n.id); }}><Trash2 className="size-4" /></Button>
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
