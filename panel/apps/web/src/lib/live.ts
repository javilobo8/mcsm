import type { QueryClient } from "@tanstack/react-query";
import type { NodeDto, ServerDto, ServerMessage } from "./api";

type ObservedMsg = Extract<ServerMessage, { type: "observed" }>;
type NodeMsg = Extract<ServerMessage, { type: "node" }>;

/** Subconjunto de `Realtime` que necesita la caché (facilita los tests). */
export interface LiveSource {
  subscribe(topic: string, handler: (msg: ServerMessage) => void): () => void;
  onReconnect(cb: () => void): () => void;
}

const ts = (iso: string | null | undefined) => (iso ? Date.parse(iso) || 0 : 0);

/** Un evento más antiguo que lo que ya tenemos en caché no debe pisarlo. */
const isStale = (s: ServerDto, m: ObservedMsg) => ts(m.observedAt) < ts(s.observedAt);

const withObserved = (s: ServerDto, m: ObservedMsg): ServerDto =>
  isStale(s, m) ? s : { ...s, observed: m.observed, observedSpecVersion: m.observed.appliedVersion, observedAt: m.observedAt };

const lastUnknownInvalidate = new WeakMap<QueryClient, number>();
const UNKNOWN_THROTTLE_MS = 1000;

export function applyObservedEvent(qc: QueryClient, msg: ObservedMsg): void {
  const list = qc.getQueryData<ServerDto[]>(["servers"]);
  if (list && !list.some((s) => s.id === msg.serverId)) {
    // Servidor creado desde otra pestaña/cliente: no hay datos para construirlo, se recarga (con límite).
    const now = Date.now();
    if (now - (lastUnknownInvalidate.get(qc) ?? 0) >= UNKNOWN_THROTTLE_MS) {
      lastUnknownInvalidate.set(qc, now);
      void qc.invalidateQueries({ queryKey: ["servers"] });
    }
  }
  // Un refetch en vuelo podría resolver después y restaurar datos más viejos que el evento.
  void qc.cancelQueries({ queryKey: ["servers"] });
  void qc.cancelQueries({ queryKey: ["server", msg.serverId] });
  qc.setQueryData<ServerDto[]>(["servers"], (old) => old?.map((s) => (s.id === msg.serverId ? withObserved(s, msg) : s)));
  qc.setQueryData<ServerDto>(["server", msg.serverId], (old) => (old ? withObserved(old, msg) : old));
}

export function applyNodeEvent(qc: QueryClient, msg: NodeMsg): void {
  qc.setQueryData<NodeDto[]>(["nodes"], (old) => {
    if (!old) return old;
    return old.some((n) => n.id === msg.node.id) ? old.map((n) => (n.id === msg.node.id ? msg.node : n)) : [...old, msg.node];
  });
}

/** Conecta la caché de React Query con el tiempo real. Devuelve la función de limpieza. */
export function bindLive(qc: QueryClient, live: LiveSource): () => void {
  const offs = [
    live.subscribe("servers", (m) => { if (m.type === "observed") applyObservedEvent(qc, m); }),
    live.subscribe("nodes", (m) => { if (m.type === "node") applyNodeEvent(qc, m); }),
    // Durante la desconexión se pierden eventos: recargamos todo.
    live.onReconnect(() => {
      void qc.invalidateQueries({ queryKey: ["servers"] });
      void qc.invalidateQueries({ queryKey: ["server"] });
      void qc.invalidateQueries({ queryKey: ["nodes"] });
    }),
  ];
  return () => offs.forEach((off) => off());
}
