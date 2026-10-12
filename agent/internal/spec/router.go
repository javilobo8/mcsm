package spec

import (
	"fmt"
	"regexp"
)

// Etiquetas de descubrimiento de mc-router en modo -in-docker (itzg/mc-router). El router enruta
// por el hostname del handshake a la IP del contenedor en la red indicada, puerto 25565.
const (
	LabelRouterHost    = "mc-router.host"
	LabelRouterNetwork = "mc-router.network"
	// MaxHostnameLen es la longitud máxima de un nombre DNS (RFC 1123).
	MaxHostnameLen = 253
)

// hostnameRe: nombre DNS en minúsculas (RFC 1123): etiquetas de 1 a 63 caracteres [a-z0-9-] que no
// empiezan ni acaban por guion, separadas por puntos, sin punto final. Misma regex que el panel
// (HOSTNAME_RE en panel/packages/shared/src/router.ts; fixture proto/fixtures/router-hostname-cases.json).
var hostnameRe = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$`)

// Router es la entrada de jugadores por hostname con el mc-router del nodo (plan-8). nil = ausente:
// sin etiquetas, el contenedor y el hash no cambian.
type Router struct {
	Enabled  bool   `json:"enabled"`
	Hostname string `json:"hostname"`
}

// ValidHostname indica si h es un hostname válido para mc-router (minúsculas, RFC 1123, ≤ 253).
func ValidHostname(h string) bool { return len(h) <= MaxHostnameLen && hostnameRe.MatchString(h) }

// Validate: activado exige hostname; un hostname presente siempre debe ser válido.
func (r *Router) Validate() error {
	if r == nil {
		return nil
	}
	if r.Enabled && r.Hostname == "" {
		return fmt.Errorf("spec: router.hostname es obligatorio con el router activado")
	}
	if r.Hostname != "" && !ValidHostname(r.Hostname) {
		return fmt.Errorf("spec: router.hostname inválido %q (minúsculas, números, guiones y puntos; máx. 253)", r.Hostname)
	}
	return nil
}

// ValidPlayer indica si p es un nombre de perfil de Java (1-16 letras, números o _) o un UUID, con
// el mismo criterio que la whitelist y los operadores (plan-8: lista del autoscale del router).
func ValidPlayer(p string) bool { return playerRe.MatchString(p) }

// Active indica si el servidor entra por el router (sección presente y activada).
func (r *Router) Active() bool { return r != nil && r.Enabled }

// addLabels añade las etiquetas de mc-router si el router está activo. mc-router.network fija la
// red por la que el router alcanza el contenedor aunque alguien lo conecte a otra.
func (r *Router) addLabels(labels map[string]string, networkName string) {
	if !r.Active() {
		return
	}
	labels[LabelRouterHost] = r.Hostname
	labels[LabelRouterNetwork] = networkName
}
