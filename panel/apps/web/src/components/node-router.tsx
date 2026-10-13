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

/** Router form of a node (inside the dialog). Exported for the tests. */
export function NodeRouterForm({ node, router, onSaved }: { node: NodeDto; router: RouterDto; onSaved: (r: RouterDto) => void }) {
  const [form, setForm] = useState(() => routerFormFrom(router.spec));
  const errors = routerFormErrors(form);
  const invalid = Object.keys(errors).length > 0;
  const status = routerStatus(router, node.status === "online");
  const save = useMutation({ mutationFn: () => saveRouter(node.id, routerFormBody(form, router.spec)), onSuccess: onSaved });
  return (
    <form className="flex flex-col gap-4" onSubmit={dialogSubmit(() => { if (!invalid) save.mutate(); })}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-zinc-400">Status:</span> <RouterBadge status={status} />
        {router.observed?.image && <span className="font-mono text-xs text-zinc-500">{router.observed.image}</span>}
      </div>
      {status.detail && <p role="alert" className="text-xs text-red-400">{status.detail}</p>}
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" className="size-4 accent-emerald-500" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
        Enable the router on this node
      </label>
      <div className="flex max-w-xs flex-col gap-1.5">
        <Label htmlFor="router-port">Host port</Label>
        <Input id="router-port" inputMode="numeric" value={form.port} aria-invalid={!!errors.port} onChange={(e) => setForm({ ...form, port: e.target.value })} />
        {errors.port
          ? <p role="alert" className="text-xs text-red-400">{errors.port}</p>
          : <p className="text-xs text-muted-foreground">25565 is Minecraft's default port, so players do not have to type a port. No server on the node can publish it.</p>}
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" className="size-4 accent-emerald-500" checked={form.autoscale} onChange={(e) => setForm({ ...form, autoscale: e.target.checked })} />
        Autoscale: start when a player joins and stop when there are no players
      </label>
      {form.autoscale && (
        <div className="flex max-w-xs flex-col gap-1.5">
          <Label htmlFor="router-minutes">Minutes without players until stopping</Label>
          <Input id="router-minutes" inputMode="numeric" value={form.minutes} aria-invalid={!!errors.minutes} onChange={(e) => setForm({ ...form, minutes: e.target.value })} />
          {errors.minutes && <p role="alert" className="text-xs text-red-400">{errors.minutes}</p>}
          <p className="text-xs text-muted-foreground">
            Servers with a hostname become on-demand: mc-router starts them when someone tries to join and stops them after those minutes without players; the panel stops starting and stopping them on its own. Stopping from the panel does not prevent a player from starting it again by joining. When a sleeping server is recreated (configuration change, restore, cold backup) it starts and mc-router puts it back to sleep after those minutes without players.
          </p>
        </div>
      )}
      {form.autoscale && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="router-players">Players who can wake servers</Label>
          <Textarea id="router-players" rows={3} value={form.players} aria-invalid={!!errors.players} placeholder="One per line (name or UUID)"
            onChange={(e) => setForm({ ...form, players: e.target.value })} />
          {errors.players
            ? <p role="alert" className="text-xs text-red-400">{errors.players}</p>
            : <p className="text-xs text-muted-foreground">Empty: anyone who reaches the router port wakes the sleeping servers (and with several at once, the node can run out of memory). Changing the list restarts the router: players connected through it are disconnected.</p>}
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        The router (itzg/mc-router) uses the node's Docker socket to find the servers with a hostname (and, with autoscale, start and stop them): it has full control of Docker on that machine, which is equivalent to root, and mounting it read-only does not limit it. It runs hardened and with the image pinned, but enable it only on trusted nodes. If the socket does not give access to its group (or Docker runs in rootless mode) the router will not see the servers. Players join through each server's hostname (Configuration → Network) with a local DNS pointing at this machine; each server also keeps its own port.
      </p>
      <Button type="submit" disabled={save.isPending || invalid}>{save.isPending ? "Saving…" : "Save"}</Button>
      {save.error && <p role="alert" className="text-sm text-red-400">{save.error.message}</p>}
    </form>
  );
}

/** Cell of the Nodes table: router status and dialog to configure it. */
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
        <Button size="sm" variant="ghost" aria-label={`Router of node ${node.name}: ${status.label}`}><RouterBadge status={status} /></Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Router of “{node.name}”</DialogTitle>
          <DialogDescription>mc-router: player entry by hostname on a single node port.</DialogDescription>
        </DialogHeader>
        {open && <NodeRouterForm node={node} router={router.data} onSaved={(r) => { qc.setQueryData(routerKey(node.id), r); setOpen(false); }} />}
      </DialogContent>
    </Dialog>
  );
}
