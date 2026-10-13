import { createUnauthorizedGate, isSessionExpired } from "./session";

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); this.name = "ApiError"; }
}

let unauthorizedHandler: (() => void) | null = null;
const gate = createUnauthorizedGate(() => unauthorizedHandler?.());

/**
 * Holds REST 401s while a mutation changes the session (password change): those from in-flight requests
 * carry the old cookie. Returns the function that releases the hold with the mutation's result and says whether
 * there was a 401 that, after a success, requires invalidating the queries ("invalidate").
 */
export const holdUnauthorized = () => gate.hold();

/** Registers what to do when the API answers 401 with an expired session. */
export function setUnauthorizedHandler(h: (() => void) | null) { unauthorizedHandler = h; }

/** For requests that do not go through `request` (XHR uploads): same 401 handling. */
export function reportStatus(status: number, path: string) { if (isSessionExpired(status, path)) gate.report(); }

export function errorMessage(status: number, statusText: string, data: unknown): string {
  const msg = (data as { error?: unknown } | null)?.error;
  if (typeof msg === "string" && msg) return msg;
  if (status >= 500) return `The panel is not responding correctly (HTTP ${status})`;
  return statusText || `HTTP error ${status}`;
}

async function request<T>(method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body !== undefined || extraHeaders ? { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...extraHeaders } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: "same-origin",
    });
  } catch {
    throw new ApiError(0, "Network error: could not reach the panel");
  }
  if (res.status === 204) return undefined as T;
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    if (isSessionExpired(res.status, path)) gate.report();
    throw new ApiError(res.status, errorMessage(res.status, res.statusText, data));
  }
  return data as T;
}

/**
 * API path with each interpolated value encoded with encodeURIComponent (L8): an id containing
 * `?`, `#` or `/` cannot add parameters or change the route. Use it for every path with values:
 * apiPath`/api/servers/${id}/power`.
 */
export function apiPath(strings: TemplateStringsArray, ...values: (string | number | boolean)[]): string {
  return strings.reduce((out, s, i) => out + s + (i < values.length ? encodeURIComponent(String(values[i])) : ""), "");
}

export const api = {
  get: <T>(p: string) => request<T>("GET", p),
  post: <T>(p: string, b?: unknown, headers?: Record<string, string>) => request<T>("POST", p, b, headers),
  patch: <T>(p: string, b?: unknown) => request<T>("PATCH", p, b),
  put: <T>(p: string, b?: unknown) => request<T>("PUT", p, b),
  del: <T>(p: string) => request<T>("DELETE", p),
};

export interface AuthStatus {
  configured: boolean; authenticated: boolean;
  /** L3: enrollment asks for the panel log's configuration token. */
  setupTokenRequired?: boolean;
}

export interface NodeDto {
  id: string; name: string; dataRoot: string; status: "online" | "offline"; agentVersion: string | null; dockerVersion: string | null;
  hostInfo: { hostname?: string; cpus?: number; memTotalBytes?: number; os?: string; arch?: string } | null; lastSeenAt: string | null; createdAt: string;
  /** plan-9: the agent has not yet connected with its new token. */
  tokenRotationPending: boolean;
}
export interface ObservedDto {
  containerId: string; state: string; health: string; startedAtUnix: number; exitCode: number; appliedVersion: number; error: string;
  mc: { online: boolean; playersOnline: number; playersMax: number; version: string; latencyMs: number };
}
export interface ServerDto {
  id: string; nodeId: string; name: string; slug: string; specVersion: number; desiredState: "running" | "stopped";
  observed: ObservedDto | null; observedSpecVersion: number; observedAt: string | null; createdAt: string; updatedAt: string;
  spec: import("@mcsm/shared").SpecInput & { ports: { game: number }; rconPassword?: string };
  /** plan-6: origin of an imported server (null if the panel created it). */
  importedFrom: import("@mcsm/shared").ImportedFrom | null;
}

// plan-4: backups and jobs
export type JobState = "queued" | "running" | "ok" | "failed" | "cancelled";
export interface JobDto {
  id: string; type: string; serverId: string | null; nodeId: string | null; status: JobState; progress: number; message: string;
  payload: Record<string, unknown>; createdAt: string; updatedAt: string; startedAt: string | null; finishedAt: string | null;
}
export interface JobDetailDto extends JobDto { log: string }
export type BackupTriggerName = "manual" | "scheduled" | "pre_migration" | "pre_restore";
export interface BackupDto {
  id: string; serverId: string; nodeId: string; filename: string; sizeBytes: number; sha256: string; specVersion: number;
  trigger: BackupTriggerName; status: "running" | "ok" | "failed" | "deleted"; startedAt: string; finishedAt: string | null;
  kind: "archive" | "directory";
}

export type ServerMessage =
  | { type: "job"; job: JobDto; logChunk: string; /** Full log (replaces the accumulated one); the panel does not send it today. */ log?: string }
  | { type: "backups"; serverId: string }
  | { type: "observed"; serverId: string; observed: ObservedDto; observedAt: string }
  | { type: "node"; node: NodeDto }
  | { type: "log"; serverId: string; ts: number; line: string }
  | { type: "log_reset"; serverId: string }
  | { type: "log_dropped"; serverId: string; count: number }
  | { type: "stream_closed"; serverId: string; reason: string }
  | { type: "node_metrics"; nodeId: string; sample: import("@mcsm/shared").NodeLiveSample }
  | { type: "router"; nodeId: string; router: import("@mcsm/shared").RouterDto } // plan-8
  | { type: "event"; event: import("@mcsm/shared").EventDto } // plan-9
  | { type: "error"; message: string };

export interface TemplateDto {
  id: string; name: string; description: string; spec: import("@mcsm/shared").TemplateSpec; sourceServerId: string | null;
  createdAt: string; updatedAt: string;
}
