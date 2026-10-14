import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Check, Copy, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PAGE, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status";
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
    <div className={PAGE}>
      <PageHeader
        title="Nodes"
        description="The machines that run your servers. Each one runs the agent, which connects to this panel."
        actions={
          <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) { setResult(null); setCopied(null); gen.reset(); } }}>
            <DialogTrigger asChild><Button>Add node</Button></DialogTrigger>
            <DialogContent className="sm:max-w-2xl">
              <DialogHeader>
                <DialogTitle>Add node</DialogTitle>
                <DialogDescription>Generates a single-use enrollment command for the new machine.</DialogDescription>
              </DialogHeader>
              {!result ? (
                <form className="flex min-w-0 flex-col gap-3" onSubmit={dialogSubmit(() => { if (!rootError) gen.mutate(); })}>
                  <div className="flex flex-col gap-1.5"><Label htmlFor="node-name">Name</Label><Input id="node-name" value={nameHint} onChange={(e) => setNameHint(e.target.value)} placeholder="nas, lounge, tower…" maxLength={40} />{!nameHint.trim() && <p className="text-xs text-warn">Without a name “node” will be used; choose a different one if you already have other nodes.</p>}</div>
                  <div className="flex flex-col gap-1.5"><Label htmlFor="node-root">Data directory on that machine</Label><Input id="node-root" value={dataRoot} onChange={(e) => setDataRoot(e.target.value)} className="font-mono" aria-invalid={!!rootError} />{rootError ? <p role="alert" className="text-xs text-bad">{rootError}</p> : <p className="text-xs text-muted-foreground">Absolute path; it is mounted at the same path inside the agent.</p>}</div>
                  <Button type="submit" disabled={gen.isPending || !!rootError}>{gen.isPending ? "Generating…" : "Generate command"}</Button>
                  {gen.error && <p role="alert" className="text-sm text-bad">{gen.error.message}</p>}
                </form>
              ) : (
                <div className="flex min-w-0 flex-col gap-3">
                  <p className="text-sm text-muted-foreground">Run this on the new machine. The token expires at {new Date(result.expiresAt).toLocaleTimeString()} and only works once. The node will appear here as soon as it connects.</p>
                  <pre data-testid="docker-run" className="whitespace-pre-wrap break-all rounded-md border border-cobble bg-obsidian p-3 text-xs leading-[1.7] text-[#e6edf3]">{result.dockerRun}</pre>
                  <Button variant="secondary" onClick={() => void copy(result.dockerRun)}>
                    {copied === "ok" ? <Check className="size-4" /> : <Copy className="size-4" />} {copied === "ok" ? "Copied" : "Copy"}
                  </Button>
                  {copied === "fail" && <p role="alert" className="text-sm text-warn">Could not copy automatically; select the text by hand.</p>}
                </div>
              )}
            </DialogContent>
          </Dialog>
        }
      />

      {nodes.isError && <p role="alert" className="text-sm text-bad">Could not load the nodes: {nodes.error.message}</p>}
      <div className="rounded-lg border border-cobble bg-bedrock/70 px-2">
        <Table>
          <TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Status</TableHead><TableHead>Router</TableHead><TableHead>Agent</TableHead><TableHead>Docker</TableHead><TableHead>Host</TableHead><TableHead>Data</TableHead><TableHead>Last seen</TableHead><TableHead><span className="sr-only">Actions</span></TableHead></TableRow></TableHeader>
          <TableBody>
            {nodes.isPending && <TableRow><TableCell colSpan={9} className="text-center text-muted-foreground">Loading nodes…</TableCell></TableRow>}
            {nodes.data?.length === 0 && <TableRow><TableCell colSpan={9} className="text-center text-muted-foreground">No nodes. Press “Add node” to enroll the first one.</TableCell></TableRow>}
            {nodes.data?.map((n) => (
              <TableRow key={n.id}>
                <TableCell className="font-medium"><Link to="/nodes/$nodeId" params={{ nodeId: n.id }} className="text-bone hover:underline">{n.name}</Link></TableCell>
                <TableCell><StatusBadge tone={n.status === "online" ? "ok" : "muted"}>{n.status === "online" ? "Online" : "Offline"}</StatusBadge></TableCell>
                <TableCell><NodeRouterCell node={n} /></TableCell>
                <TableCell>{n.agentVersion ?? "—"}</TableCell>
                <TableCell>{n.dockerVersion ?? "—"}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{n.hostInfo?.hostname ? `${n.hostInfo.hostname} · ${n.hostInfo.os ?? "?"}/${n.hostInfo.arch ?? "?"}` : "—"}</TableCell>
                <TableCell className="font-mono text-xs">{n.dataRoot}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{n.lastSeenAt ? new Date(n.lastSeenAt).toLocaleString() : "never"}</TableCell>
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
      </div>
      {del.error && <p role="alert" className="text-sm text-bad">{del.error.message}</p>}
    </div>
  );
}
