import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { realtime } from "@/lib/ws";
import { bindLive } from "@/lib/live";
import { bindNodeMetrics } from "@/lib/metrics";
import { bindEvents } from "@/lib/events";

/** Mantiene la caché de servidores y nodos sincronizada con el WS mientras el componente esté montado. */
export function useLive() {
  const qc = useQueryClient();
  useEffect(() => {
    const offs = [bindLive(qc, realtime), bindNodeMetrics(qc, realtime), bindEvents(qc, realtime)];
    return () => offs.forEach((off) => off());
  }, [qc]);
}
