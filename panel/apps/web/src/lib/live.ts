import type { QueryClient } from "@tanstack/react-query";
import type { NodeDto, ServerDto, ServerMessage } from "./api";

type ObservedMsg = Extract<ServerMessage, { type: "observed" }>;
type NodeMsg = Extract<ServerMessage, { type: "node" }>;

/** Subset of `Realtime` the cache needs (makes testing easier). */
export interface LiveSource {
  subscribe(topic: string, handler: (msg: ServerMessage) => void): () => void;
  onReconnect(cb: () => void): () => void;
}

const ts = (iso: string | null | undefined) => (iso ? Date.parse(iso) || 0 : 0);

/** An event older than what we already have in cache must not overwrite it. */
const isStale = (s: ServerDto, m: ObservedMsg) => ts(m.observedAt) < ts(s.observedAt);

const withObserved = (s: ServerDto, m: ObservedMsg): ServerDto =>
  isStale(s, m) ? s : { ...s, observed: m.observed, observedSpecVersion: m.observed.appliedVersion, observedAt: m.observedAt };

const UNKNOWN_THROTTLE_MS = 1000;
const unknownThrottle = new WeakMap<QueryClient, { last: number; timer: ReturnType<typeof setTimeout> | null }>();

/** Invalidates ["servers"] at most once per second, with a final (trailing) call so the last one is not lost. */
function invalidateServersThrottled(qc: QueryClient) {
  const st = unknownThrottle.get(qc) ?? { last: 0, timer: null };
  unknownThrottle.set(qc, st);
  const fire = () => { st.last = Date.now(); st.timer = null; void qc.invalidateQueries({ queryKey: ["servers"] }); };
  const wait = UNKNOWN_THROTTLE_MS - (Date.now() - st.last);
  if (wait <= 0) return fire();
  if (!st.timer) st.timer = setTimeout(fire, wait);
}

/**
 * Merges `update` into the `queryKey` query if it already has data. Without data (initial load) it does
 * nothing: cancelling it would leave it pending forever and the load itself will bring the state. If the query
 * is REFETCHING it is cancelled (so the old response does not overwrite the event) and written once the
 * cancellation, which reverts asynchronously, has finished.
 */
export function mergeIntoCached<T>(qc: QueryClient, queryKey: readonly unknown[], update: (old: T) => T): void {
  if (qc.getQueryData<T>(queryKey) === undefined) return;
  const write = () => qc.setQueryData<T>(queryKey, (old) => (old === undefined ? old : update(old)));
  if (qc.isFetching({ queryKey, exact: true }) === 0) return void write();
  void qc.cancelQueries({ queryKey, exact: true }).then(write, write);
}

export function applyObservedEvent(qc: QueryClient, msg: ObservedMsg): void {
  // List ["servers"].
  const list = qc.getQueryData<ServerDto[]>(["servers"]);
  if (list && !list.some((s) => s.id === msg.serverId)) {
    // Server created from another tab/client: there is no data to build it, it is reloaded (throttled).
    // Without cancelling: it would abort the refetch just launched.
    invalidateServersThrottled(qc);
  } else {
    mergeIntoCached<ServerDto[]>(qc, ["servers"], (old) => old.map((s) => (s.id === msg.serverId ? withObserved(s, msg) : s)));
  }
  // Detail ["server", id]: independent of the list (it may be cached even if the list does not know it).
  mergeIntoCached<ServerDto>(qc, ["server", msg.serverId], (old) => withObserved(old, msg));
}

export function applyNodeEvent(qc: QueryClient, msg: NodeMsg): void {
  qc.setQueryData<NodeDto[]>(["nodes"], (old) => {
    if (!old) return old;
    return old.some((n) => n.id === msg.node.id) ? old.map((n) => (n.id === msg.node.id ? msg.node : n)) : [...old, msg.node];
  });
}

/** Connects the React Query cache to realtime. Returns the cleanup function. */
export function bindLive(qc: QueryClient, live: LiveSource): () => void {
  const offs = [
    live.subscribe("servers", (m) => { if (m.type === "observed") applyObservedEvent(qc, m); }),
    live.subscribe("nodes", (m) => { if (m.type === "node") applyNodeEvent(qc, m); }),
    // Events are lost during the disconnection: we reload everything.
    live.onReconnect(() => {
      void qc.invalidateQueries({ queryKey: ["servers"] });
      void qc.invalidateQueries({ queryKey: ["server"] });
      void qc.invalidateQueries({ queryKey: ["nodes"] });
    }),
  ];
  return () => offs.forEach((off) => off());
}
