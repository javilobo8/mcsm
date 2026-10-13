package spec

import (
	"fmt"
	"regexp"
)

// mc-router discovery labels in -in-docker mode (itzg/mc-router). The router routes
// by the handshake hostname to the container's IP on the given network, port 25565.
const (
	LabelRouterHost    = "mc-router.host"
	LabelRouterNetwork = "mc-router.network"
	// MaxHostnameLen is the maximum length of a DNS name (RFC 1123).
	MaxHostnameLen = 253
)

// hostnameRe: lowercase DNS name (RFC 1123): labels of 1 to 63 characters [a-z0-9-] that neither
// start nor end with a dash, separated by dots, no trailing dot. Same regex as the panel
// (HOSTNAME_RE in panel/packages/shared/src/router.ts; fixture proto/fixtures/router-hostname-cases.json).
var hostnameRe = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$`)

// Router is player entry by hostname through the node's mc-router (plan-8). nil = absent:
// no labels, the container and the hash do not change.
type Router struct {
	Enabled  bool   `json:"enabled"`
	Hostname string `json:"hostname"`
}

// ValidHostname reports whether h is a valid hostname for mc-router (lowercase, RFC 1123, ≤ 253).
func ValidHostname(h string) bool { return len(h) <= MaxHostnameLen && hostnameRe.MatchString(h) }

// Validate: enabled requires a hostname; a present hostname must always be valid.
func (r *Router) Validate() error {
	if r == nil {
		return nil
	}
	if r.Enabled && r.Hostname == "" {
		return fmt.Errorf("spec: router.hostname is required with the router enabled")
	}
	if r.Hostname != "" && !ValidHostname(r.Hostname) {
		return fmt.Errorf("spec: invalid router.hostname %q (lowercase letters, digits, dashes and dots; max. 253)", r.Hostname)
	}
	return nil
}

// ValidPlayer reports whether p is a Java profile name (1-16 letters, digits or _) or a UUID, with
// the same criterion as the whitelist and operators (plan-8: the router's autoscale list).
func ValidPlayer(p string) bool { return playerRe.MatchString(p) }

// Active reports whether the server enters through the router (section present and enabled).
func (r *Router) Active() bool { return r != nil && r.Enabled }

// addLabels adds the mc-router labels if the router is active. mc-router.network sets the
// network through which the router reaches the container even if someone connects it to another.
func (r *Router) addLabels(labels map[string]string, networkName string) {
	if !r.Active() {
		return
	}
	labels[LabelRouterHost] = r.Hostname
	labels[LabelRouterNetwork] = networkName
}
