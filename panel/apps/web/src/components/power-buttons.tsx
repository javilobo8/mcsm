import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Play, Square, RotateCcw, Skull } from "lucide-react";
import { Button } from "@/components/ui/button";
import { canPower } from "@/lib/format";
import { api, apiPath, ApiError, type ServerDto } from "@/lib/api";

type Action = "start" | "stop" | "restart" | "kill";

export function PowerButtons({ server, size = "sm", nodeOnline }: { server: ServerDto; size?: "sm" | "default"; nodeOnline?: boolean }) {
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: (action: Action) => api.post<ServerDto>(apiPath`/api/servers/${server.id}/power`, { action }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["servers"] });
      void qc.invalidateQueries({ queryKey: ["server", server.id] });
    },
  });
  const allowed = canPower(nodeOnline);
  const off = m.isPending || !allowed;
  const t = (label: string) => (allowed ? label : "Node offline");
  const running = server.observed?.state === "running";
  const err = m.error instanceof ApiError ? m.error.message : m.error ? "Unexpected error" : null;
  const kill = () => {
    if (confirm(`Kill the process of "${server.name}" without saving? It can corrupt the world.`)) m.mutate("kill");
  };
  return (
    <div className="flex items-center gap-1">
      {!allowed && <span className="sr-only">Node offline: actions not available</span>}
      {!running && <Button size={size} variant="secondary" disabled={off} onClick={() => m.mutate("start")} title={t("Start")} aria-label={`Start ${server.name}`}><Play className="size-4" /></Button>}
      {running && <Button size={size} variant="secondary" disabled={off} onClick={() => m.mutate("stop")} title={t("Stop")} aria-label={`Stop ${server.name}`}><Square className="size-4" /></Button>}
      {running && <Button size={size} variant="ghost" disabled={off} onClick={() => m.mutate("restart")} title={t("Restart")} aria-label={`Restart ${server.name}`}><RotateCcw className="size-4" /></Button>}
      {running && <Button size={size} variant="ghost" disabled={off} onClick={kill} title={t("Kill")} aria-label={`Kill ${server.name}`}><Skull className="size-4" /></Button>}
      {err && <span role="alert" className="max-w-48 text-xs text-red-400">{err}</span>}
    </div>
  );
}
