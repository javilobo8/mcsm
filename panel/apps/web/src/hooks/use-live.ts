import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { realtime } from "@/lib/ws";
import { bindLive } from "@/lib/live";

/** Mantiene la caché de servidores y nodos sincronizada con el WS mientras el componente esté montado. */
export function useLive() {
  const qc = useQueryClient();
  useEffect(() => bindLive(qc, realtime), [qc]);
}
