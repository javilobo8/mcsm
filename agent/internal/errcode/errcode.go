// Package errcode is the catalog of Error.code values the agent sends to the panel. The
// comment on `message Error` in proto/mcsm/v1/agent.proto documents it with its
// HTTP translation, and panel/apps/api/src/agents/error-codes.ts is its TS mirror.
// A new code is added in all three places; the panel maps unknown ones to 502.
package errcode

const (
	InvalidSpec    = "invalid_spec"    // invalid spec (server_id or slug)
	InvalidRequest = "invalid_request" // malformed request
	UnknownServer  = "unknown_server"  // the node does not know that server
	NotFound       = "not_found"       // nonexistent resource (file, backup…)
	Busy           = "busy"            // server busy or reserved (the message gives the reason)
	Exists         = "exists"          // already exists
	Unsupported    = "unsupported"     // the agent does not understand the message: it is out of date
	TooLarge       = "too_large"       // too large
	ApplyFailed    = "apply_failed"    // failed to apply the spec (Docker text)
	RemoveFailed   = "remove_failed"   // failed to delete the server
	PowerFailed    = "power_failed"    // power action failed
	BadSpec        = "bad_spec"        // the stored spec cannot be read
	RconFailed     = "rcon_failed"     // RCON failure
	BackupFailed   = "backup_failed"   // a backup, restore or backup deletion failed
)

// Files (Plan 5). unknown_server, not_found, exists and too_large are above.
const (
	InvalidPath    = "invalid_path"    // path with "..", control characters or a non-regular file
	PathOutside    = "path_outside"    // the resolved path leaves the server's /data
	IsDir          = "is_dir"          // it was a file and is a folder
	NotDir         = "not_dir"         // it was a folder and is a file
	Root           = "root"            // operation not allowed on the root
	TransferFailed = "transfer_failed" // upload/download failed
	IOError        = "io_error"        // host I/O error
)

// Import (Plan 6).
const (
	ExternalData = "external_data" // server data outside DATA_ROOT (dataPath): no backups or files
)
