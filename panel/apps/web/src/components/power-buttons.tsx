import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Play, Square, RotateCcw, Skull } from "lucide-react";
import { Button } from "@/components/ui/button";
import { canPower } from "@/lib/format";
import { api, ApiError, type ServerDto } from "@/lib/api";

type Action = "start" | "stop" | "restart" | "kill";

export function PowerButtons({ server, size = "sm", nodeOnline }: { server: ServerDto; size?: "sm" | "default"; nodeOnline?: boolean }) {
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: (action: Action) => api.post<ServerDto>(`/api/servers/${server.id}/power`, { action }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["servers"] });
      void qc.invalidateQueries({ queryKey: ["server", server.id] });
    },
  });
  const allowed = canPower(nodeOnline);
  const off = m.isPending || !allowed;
  const t = (label: string) => (allowed ? label : "Nodo desconectado");
  const running = server.observed?.state === "running";
  const err = m.error instanceof ApiError ? m.error.message : m.error ? "Error inesperado" : null;
  const kill = () => {
    if (confirm(`¿Matar el proceso de "${server.name}" sin guardar? Puede corromper el mundo.`)) m.mutate("kill");
  };
  return (
    <div className="flex items-center gap-1">
      {!allowed && <span className="sr-only">Nodo desconectado: acciones no disponibles</span>}
      {!running && <Button size={size} variant="secondary" disabled={off} onClick={() => m.mutate("start")} title={t("Arrancar")} aria-label={`Arrancar ${server.name}`}><Play className="size-4" /></Button>}
      {running && <Button size={size} variant="secondary" disabled={off} onClick={() => m.mutate("stop")} title={t("Parar")} aria-label={`Parar ${server.name}`}><Square className="size-4" /></Button>}
      {running && <Button size={size} variant="ghost" disabled={off} onClick={() => m.mutate("restart")} title={t("Reiniciar")} aria-label={`Reiniciar ${server.name}`}><RotateCcw className="size-4" /></Button>}
      {running && <Button size={size} variant="ghost" disabled={off} onClick={kill} title={t("Matar")} aria-label={`Matar ${server.name}`}><Skull className="size-4" /></Button>}
      {err && <span role="alert" className="max-w-48 text-xs text-red-400">{err}</span>}
    </div>
  );
}
