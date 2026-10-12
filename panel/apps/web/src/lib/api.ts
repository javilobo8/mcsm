export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? res.statusText);
  return data as T;
}

export const api = {
  get: <T>(p: string) => request<T>("GET", p),
  post: <T>(p: string, b?: unknown) => request<T>("POST", p, b),
  patch: <T>(p: string, b?: unknown) => request<T>("PATCH", p, b),
  del: <T>(p: string) => request<T>("DELETE", p),
};

export interface AuthStatus { configured: boolean; authenticated: boolean }

export interface NodeDto {
  id: string; name: string; dataRoot: string; status: "online" | "offline"; agentVersion: string | null; dockerVersion: string | null;
  hostInfo: { hostname?: string; cpus?: number; memTotalBytes?: number; os?: string; arch?: string } | null; lastSeenAt: string | null; createdAt: string;
}
export interface ObservedDto {
  containerId: string; state: string; health: string; startedAtUnix: number; exitCode: number; appliedVersion: number; error: string;
  mc: { online: boolean; playersOnline: number; playersMax: number; version: string; latencyMs: number };
}
export interface ServerDto {
  id: string; nodeId: string; name: string; slug: string; specVersion: number; desiredState: "running" | "stopped";
  observed: ObservedDto | null; observedSpecVersion: number; observedAt: string | null; createdAt: string; updatedAt: string;
  spec: import("@mcsm/shared").SpecInput & { ports: { game: number }; rconPassword?: string };
}

export type ServerMessage =
  | { type: "observed"; serverId: string; observed: ObservedDto; observedAt: string }
  | { type: "node"; node: NodeDto }
  | { type: "log"; serverId: string; ts: number; line: string }
  | { type: "stream_closed"; serverId: string; reason: string }
  | { type: "error"; message: string };
