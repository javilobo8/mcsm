// Package errcode es el catálogo de Error.code que el agente envía al panel. El
// comentario de `message Error` en proto/mcsm/v1/agent.proto lo documenta con su
// traducción a HTTP, y panel/apps/api/src/agents/error-codes.ts es su espejo en TS.
// Un código nuevo se añade en los tres sitios; el panel traduce los desconocidos a 502.
package errcode

const (
	InvalidSpec    = "invalid_spec"    // spec inválida (server_id o slug)
	InvalidRequest = "invalid_request" // petición mal formada
	UnknownServer  = "unknown_server"  // el nodo no conoce ese servidor
	NotFound       = "not_found"       // recurso inexistente (fichero, copia…)
	Busy           = "busy"            // el servidor está ocupado con otra operación
	Exists         = "exists"          // ya existe
	Unsupported    = "unsupported"     // el agente no entiende el mensaje: está desactualizado
	TooLarge       = "too_large"       // demasiado grande
	ApplyFailed    = "apply_failed"    // fallo al aplicar la spec (texto de Docker)
	RemoveFailed   = "remove_failed"   // fallo al borrar el servidor
	PowerFailed    = "power_failed"    // fallo de la acción de encendido
	BadSpec        = "bad_spec"        // la spec guardada no se puede leer
	RconFailed     = "rcon_failed"     // fallo de RCON
)

// Archivos (Plan 5). unknown_server, not_found, exists y too_large están arriba.
const (
	InvalidPath    = "invalid_path"    // ruta con «..», caracteres de control o fichero no regular
	PathOutside    = "path_outside"    // la ruta resuelta sale de /data del servidor
	IsDir          = "is_dir"          // era un fichero y es una carpeta
	NotDir         = "not_dir"         // era una carpeta y es un fichero
	Root           = "root"            // operación no permitida sobre la raíz
	TransferFailed = "transfer_failed" // subida/descarga fallida
	IOError        = "io_error"        // error de E/S del host
)
