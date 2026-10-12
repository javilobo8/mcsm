/**
 * Catálogo de `Error.code` (ver el comentario de `message Error` en proto/mcsm/v1/agent.proto y
 * su espejo en Go, agent/internal/errcode). `agentErrorToHttp` (lib/http.ts) traduce cada código
 * a un estado HTTP; un código desconocido acaba en 502 con el texto del agente.
 */
export const AgentErrorCode = {
  // Agente → panel.
  InvalidSpec: "invalid_spec",
  InvalidRequest: "invalid_request",
  UnknownServer: "unknown_server",
  NotFound: "not_found",
  Busy: "busy",
  Exists: "exists",
  Unsupported: "unsupported",
  TooLarge: "too_large",
  ApplyFailed: "apply_failed",
  RemoveFailed: "remove_failed",
  PowerFailed: "power_failed",
  BadSpec: "bad_spec",
  BackupFailed: "backup_failed",
  RconFailed: "rcon_failed",
  // Archivos.
  InvalidPath: "invalid_path",
  PathOutside: "path_outside",
  IsDir: "is_dir",
  NotDir: "not_dir",
  Root: "root",
  TransferFailed: "transfer_failed",
  IoError: "io_error",
  // Importación (Plan 6).
  ExternalData: "external_data",
  // Solo en el panel: AgentError local de AgentConn, nunca viaja por el WS.
  Disconnected: "disconnected",
  Syncing: "syncing",
  Timeout: "timeout",
  Protocol: "protocol",
} as const;

export type AgentErrorCode = (typeof AgentErrorCode)[keyof typeof AgentErrorCode];
