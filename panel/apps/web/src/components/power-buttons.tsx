import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Play, Square, RotateCcw, Skull } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, ApiError, type ServerDto } from "@/lib/api";

type Action = "start" | "stop" | "restart" | "kill";

export function PowerButtons({ server, size = "sm" }: { server: ServerDto; size?: "sm" | "default" }) {
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: (action: Action) => api.post<ServerDto>(`/api/servers/${server.id}/power`, { action }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["servers"] });
      void qc.invalidateQueries({ queryKey: ["server", server.id] });
    },
  });
  const running = server.observed?.state === "running";
  const err = m.error instanceof ApiError ? m.error.message : m.error ? "Error inesperado" : null;
  const kill = () => {
    if (confirm(`¿Matar el proceso de "${server.name}" sin guardar? Puede corromper el mundo.`)) m.mutate("kill");
  };
  return (
    <div className="flex items-center gap-1">
      {!running && <Button size={size} variant="secondary" disabled={m.isPending} onClick={() => m.mutate("start")} title="Arrancar" aria-label={`Arrancar ${server.name}`}><Play className="size-4" /></Button>}
      {running && <Button size={size} variant="secondary" disabled={m.isPending} onClick={() => m.mutate("stop")} title="Parar" aria-label={`Parar ${server.name}`}><Square className="size-4" /></Button>}
      {running && <Button size={size} variant="ghost" disabled={m.isPending} onClick={() => m.mutate("restart")} title="Reiniciar" aria-label={`Reiniciar ${server.name}`}><RotateCcw className="size-4" /></Button>}
      {running && <Button size={size} variant="ghost" disabled={m.isPending} onClick={kill} title="Matar" aria-label={`Matar ${server.name}`}><Skull className="size-4" /></Button>}
      {err && <span role="alert" className="max-w-48 text-xs text-red-400">{err}</span>}
    </div>
  );
}
