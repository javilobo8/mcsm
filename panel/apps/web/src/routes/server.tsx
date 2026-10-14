import { useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Trash2 } from "lucide-react";
import { TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { StateBadge } from "@/components/state-badge";
import { PAGE, PageHeader, SectionTitle } from "@/components/page-header";
import { BackupsTab } from "@/components/backups-tab";
import { EventList } from "@/components/event-list";
import { JobList } from "@/components/job-list";
import { PowerButtons } from "@/components/power-buttons";
import { Console } from "@/components/console";
import { ServerCharts } from "@/components/server-charts";
import { ServerConfigForm } from "@/components/server-config-form";
import { FileBrowser } from "@/components/files/file-browser";
import { GuardedTabs } from "@/components/guarded-tabs";
import { ExternalDataNote, ImportNotices } from "@/components/import-notices";
import { MigrateTab } from "@/components/migrate-tab";
import { MigrationBanner } from "@/components/migration-banner";
import { useServer } from "@/hooks/use-servers";
import { useNodes } from "@/hooks/use-nodes";
import { api, apiPath, ApiError } from "@/lib/api";
import { formatUptime } from "@/lib/format";
import { serverImportView } from "@/lib/import";

/** One cell of the Overview's spec sheet (a grid of cells split by hairlines). */
function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0 bg-bedrock px-4 py-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 truncate text-base font-medium text-bone tabular-nums">{value}</dd>
    </div>
  );
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
    mutationFn: () => api.del(apiPath`/api/servers/${serverId}?deleteData=${deleteData && !q.data?.spec.dataPath}`),
    onSuccess: () => {
      void navigate({ to: "/" }).then(() => {
        qc.removeQueries({ queryKey: ["server", serverId] });
        void qc.invalidateQueries({ queryKey: ["servers"] });
      });
    },
  });

  if (q.isPending) return <div className="flex items-center gap-2 p-4 sm:p-6 lg:p-8 text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading…</div>;
  if (q.isError || !q.data) {
    const notFound = q.error instanceof ApiError && q.error.status === 404;
    return (
      <div role="alert" className="flex flex-col items-start gap-2 p-4 sm:p-6 lg:p-8 text-bad">
        <p>{notFound ? "Server not found" : `Could not load the server: ${q.error?.message ?? "unknown error"}`}</p>
        {!notFound && <Button variant="secondary" size="sm" onClick={() => void q.refetch()}>Retry</Button>}
      </div>
    );
  }
  const s = q.data;
  const o = s.observed;
  const node = nodes.data?.find((n) => n.id === s.nodeId);
  const nodeOnline = nodes.data ? node?.status === "online" : undefined;
  const applying = s.specVersion !== s.observedSpecVersion;
  const iv = serverImportView(s); // plan-6: data outside DATA_ROOT; imported and still in its original container

  return (
    <div className={PAGE}>
      <PageHeader
        title={s.name}
        description={
          <div className="flex flex-wrap items-center gap-2">
            <StateBadge observed={o} desired={s.desiredState} nodeOnline={nodeOnline} />
            <span>{node?.name ?? "—"} · port {s.spec.ports.game} · {s.spec.type} {s.spec.version} · {s.spec.memory}</span>
            {applying && nodeOnline !== false && <span role="status" className="flex items-center gap-1 text-warn"><Loader2 className="size-3 animate-spin" /> Applying v{s.specVersion}… (current v{s.observedSpecVersion})</span>}
            {applying && nodeOnline === false && <span className="text-warn">v{s.specVersion} pending: it will be applied when the node is back online</span>}
          </div>
        }
        actions={
          <>
            <PowerButtons server={s} size="default" nodeOnline={nodeOnline} />
            <Button variant="ghost" size="icon" aria-label={`Delete ${s.name}`} title="Delete server" onClick={() => { del.reset(); setDeleteData(false); setConfirmDel(true); }}><Trash2 className="size-4" /></Button>
          </>
        }
      >
        {nodeOnline === false && <p className="mt-2 text-sm text-warn">The node “{node?.name}” is offline: the state shown may be outdated and actions are not available.</p>}
        {o?.error && <p className="mt-3 max-w-3xl rounded-md border border-redstone/35 bg-redstone/[0.08] p-2 font-mono text-xs text-bad">{o.error}</p>}
        <ImportNotices server={s} />
      </PageHeader>
      <MigrationBanner key={s.id} serverId={s.id} />

      <GuardedTabs defaultValue="overview">
        <TabsList><TabsTrigger value="overview">Overview</TabsTrigger><TabsTrigger value="console">Console</TabsTrigger><TabsTrigger value="config">Configuration</TabsTrigger>
          {/* ── plan-2 ── */}
          {/* ── plan-3 ── */}
          {/* ── plan-4 ── */}
          <TabsTrigger value="backups">Backups</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
          {/* ── plan-5 ── */}
          <TabsTrigger value="files">Files</TabsTrigger>
          {/* ── plan-6 ── */}
          {/* ── plan-7 ── */}
          <TabsTrigger value="migrate">Migrate</TabsTrigger>
          {/* ── plan-8 ── */}
          {/* ── plan-9 ── */}
        </TabsList>
        <TabsContent value="overview" className="flex flex-col gap-6">
          <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-cobble bg-cobble md:grid-cols-4">
            <Stat label="Players" value={o?.mc.online ? `${o.mc.playersOnline} / ${o.mc.playersMax}` : "—"} />
            <Stat label="Detected version" value={o?.mc.version || "—"} />
            <Stat label="Uptime" value={o?.state === "running" ? formatUptime(o.startedAtUnix) : "—"} />
            <Stat label="Latency" value={o?.mc.online ? `${o.mc.latencyMs} ms` : "—"} />
            <Stat label="Container" value={<code className="text-sm">{o?.containerId ? o.containerId.slice(0, 12) : "—"}</code>} />
            <Stat label="Healthcheck" value={o?.health || "—"} />
            <Stat label="Last exit code" value={o && o.state !== "running" ? o.exitCode : "—"} />
            <Stat label="Spec" value={applying ? `v${s.specVersion} (applying; current v${s.observedSpecVersion})` : `v${s.specVersion} (applied)`} />
          </dl>
          <ServerCharts key={s.id} serverId={s.id} />
        </TabsContent>
        <TabsContent value="console" key={s.nodeId}><Console key={s.id} serverId={s.id} nodeOnline={nodeOnline} /></TabsContent>
        <TabsContent value="config"><ServerConfigForm key={s.id} server={s} /></TabsContent>
        {/* ── plan-2 ── */}
        {/* ── plan-3 ── */}
        {/* ── plan-4 ── */}
        <TabsContent value="backups">{iv.backups ? <ExternalDataNote text={iv.backups} /> : <BackupsTab key={s.id} server={s} nodeOnline={nodeOnline} />}</TabsContent>
        <TabsContent value="history" className="flex flex-col gap-6">
          <section aria-label="Server events" className="flex flex-col gap-3">
            <SectionTitle>Events</SectionTitle>
            <EventList key={s.id} filter={{ serverId: s.id }} showSubject={false} />
          </section>
          <section aria-label="Server jobs" className="flex flex-col gap-3">
            <SectionTitle>Jobs</SectionTitle>
            <JobList key={s.id} filter={{ serverId: s.id }} showServer={false} />
          </section>
        </TabsContent>
        {/* ── plan-5 ── */}
        <TabsContent value="files">{iv.files ? <ExternalDataNote text={iv.files} /> : <FileBrowser key={s.id} serverId={s.id} nodeOnline={nodeOnline} />}</TabsContent>
        {/* ── plan-6 ── */}
        {/* ── plan-7 ── */}
        <TabsContent value="migrate">{iv.migrate ? <ExternalDataNote text={iv.migrate} /> : <MigrateTab key={s.id} server={s} nodeOnline={nodeOnline} />}</TabsContent>
        {/* ── plan-8 ── */}
        {/* ── plan-9 ── */}
      </GuardedTabs>

      <Dialog open={confirmDel} onOpenChange={(o) => { if (!del.isPending) setConfirmDel(o); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete “{s.name}”</DialogTitle>
            <DialogDescription>{iv.deleteDescription}</DialogDescription>
          </DialogHeader>
          <label className={`flex items-start gap-2 text-sm${iv.deleteData ? " text-muted-foreground" : ""}`}>
            <input type="checkbox" className="mt-1" disabled={iv.deleteData !== null} checked={deleteData && iv.deleteData === null} onChange={(e) => setDeleteData(e.target.checked)} />
            <span>{iv.deleteData ?? `Also delete the world and files of “${s.name}” on the node. This action cannot be undone.`}</span>
          </label>
          {del.error && <p role="alert" className="text-sm text-bad">{del.error instanceof ApiError ? del.error.message : "Unexpected error"}</p>}
          <DialogFooter>
            <Button variant="ghost" disabled={del.isPending} onClick={() => setConfirmDel(false)}>Cancel</Button>
            <Button variant="destructive" disabled={del.isPending} onClick={() => del.mutate()}>{del.isPending ? "Deleting…" : deleteData && iv.deleteData === null ? "Delete with data" : "Delete"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
