import { isSessionExpired } from "./session";

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); this.name = "ApiError"; }
}

let unauthorizedHandler: (() => void) | null = null;
/** Registra qué hacer cuando la API responde 401 con la sesión caducada. */
export function setUnauthorizedHandler(h: (() => void) | null) { unauthorizedHandler = h; }

export function errorMessage(status: number, statusText: string, data: unknown): string {
  const msg = (data as { error?: unknown } | null)?.error;
  if (typeof msg === "string" && msg) return msg;
  if (status >= 500) return `El panel no responde correctamente (HTTP ${status})`;
  return statusText || `Error HTTP ${status}`;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: "same-origin",
    });
  } catch {
    throw new ApiError(0, "Error de red: no se pudo contactar con el panel");
  }
  if (res.status === 204) return undefined as T;
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    if (isSessionExpired(res.status, path)) unauthorizedHandler?.();
    throw new ApiError(res.status, errorMessage(res.status, res.statusText, data));
  }
  return data as T;
}

/**
 * Ruta de la API con cada valor interpolado codificado con encodeURIComponent (L8): un id con
 * `?`, `#` o `/` no puede añadir parámetros ni cambiar de ruta. Úsalo en toda ruta con valores:
 * apiPath`/api/servers/${id}/power`.
 */
export function apiPath(strings: TemplateStringsArray, ...values: (string | number | boolean)[]): string {
  return strings.reduce((out, s, i) => out + s + (i < values.length ? encodeURIComponent(String(values[i])) : ""), "");
}

export const api = {
  get: <T>(p: string) => request<T>("GET", p),
  post: <T>(p: string, b?: unknown) => request<T>("POST", p, b),
  patch: <T>(p: string, b?: unknown) => request<T>("PATCH", p, b),
  put: <T>(p: string, b?: unknown) => request<T>("PUT", p, b),
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
  | { type: "log_reset"; serverId: string }
  | { type: "log_dropped"; serverId: string; count: number }
  | { type: "stream_closed"; serverId: string; reason: string }
  | { type: "node_metrics"; nodeId: string; sample: import("@mcsm/shared").NodeLiveSample }
  | { type: "error"; message: string };

export interface TemplateDto {
  id: string; name: string; description: string; spec: import("@mcsm/shared").TemplateSpec; sourceServerId: string | null;
  createdAt: string; updatedAt: string;
}
