/**
 * Catalog of `Error.code` (see the comment on `message Error` in proto/mcsm/v1/agent.proto and
 * its Go mirror, agent/internal/errcode). `agentErrorToHttp` (lib/http.ts) maps each code
 * to an HTTP status; an unknown code ends up as 502 with the agent's text.
 */
export const AgentErrorCode = {
  // Agent → panel.
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
  // Files.
  InvalidPath: "invalid_path",
  PathOutside: "path_outside",
  IsDir: "is_dir",
  NotDir: "not_dir",
  Root: "root",
  TransferFailed: "transfer_failed",
  IoError: "io_error",
  // Import (Plan 6).
  ExternalData: "external_data",
  // Panel only: local AgentError from AgentConn, never travels over the WS.
  Disconnected: "disconnected",
  Syncing: "syncing",
  Timeout: "timeout",
  Protocol: "protocol",
} as const;

export type AgentErrorCode = (typeof AgentErrorCode)[keyof typeof AgentErrorCode];
