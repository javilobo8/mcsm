// Package router maintains a node's mc-router (plan-8): an itzg/mc-router container with
// Docker discovery (-in-docker) on the servers' network, which publishes a host port
// and routes each connection by the handshake hostname to the container with that mc-router.host label.
//
// Docker socket risk: mc-router needs it to discover the servers (and, with autoscale,
// to start and stop them). Whoever controls that socket controls the host, just like the agent. What
// the container can do by itself is reduced: pinned image (Tag), non-root user
// (65532), CapDrop ALL, no-new-privileges, read-only root, memory and process limits, no
// mc-router HTTP API and no other mounts. Since Plan 9 the router does not receive the Docker socket:
// it mounts (read-only) the directory of the agent proxy's socket (dockerproxy package), which only
// allows listing, inspecting without env, following events and starting or stopping servers with unreserved
// hostnames. The mount's ":ro" does not prevent connect() on the socket; it prevents creating or changing
// files in that directory.
package router

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/spec"
)

const (
	// ContainerName is the name of the router's container on a node (tests use mcsm-test-…).
	ContainerName = "mcsm-router"
	Image         = "itzg/mc-router"
	// Tag pins the mc-router version and Digest the multi-architecture index published with it
	// (docker buildx imagetools inspect itzg/mc-router:1.47.1). The container receives the Docker
	// socket: a re-published tag must not reach any node. Changing them changes the hash: when
	// the agent is updated, the router is recreated with the new image.
	Tag    = "1.47.1"
	Digest = "sha256:177433dd91507339924d60205a19ae9a289afd0e69dbad54e1a55d497f7523f8"
	// LabelRouter marks the router's container (besides mcsm.managed, to receive its events).
	LabelRouter = "mcsm.router"
	// LabelHash stores the configuration hash to detect changes without comparing field by field.
	LabelHash = "mcsm.router_hash"
	// ListenPort is mc-router's port inside the container.
	ListenPort = 25565
	// HostSocket is the host's real Docker socket: the upstream of the agent's proxy.
	HostSocket = "/var/run/docker.sock"
	// RouterSocketDir is where the router sees the proxy socket's DIRECTORY (m5): mounting the file would leave the
	// router on the previous socket every time the agent restarts (another inode), and if it were missing when the
	// host boots, Docker would create a directory at its path. mc-router reconnects by itself (with backoff of up to 30 s)
	// when the socket disappears and appears again. Its Docker client goes there with -docker-socket.
	RouterSocketDir = "/run/mcsm"
	// User is the image's non-root user (chainguard static).
	User = "65532:65532"

	DefaultDownAfterMinutes = 10
	MaxDownAfterMinutes     = 1440
	// MaxAllowPlayers is the cap on the list of players that wake up servers (like the spec's lists).
	MaxAllowPlayers = 1000
	// AllowDenyFile is the name of the -auto-scale-allow-deny file in the host directory
	// (Options.FilesDir) and allowDenyMount where mc-router sees it.
	AllowDenyFile  = "allow-deny.json"
	allowDenyMount = "/etc/mc-router/allow-deny.json"

	memoryLimit = 256 << 20
	pidsLimit   = 256
	hashSchema  = 2 // plan-9: the proxy's socket (its directory) instead of Docker's (the router is recreated once on update)
	// connectionRateLimit: new connections per second (global). mc-router's default of 1 makes
	// several players refreshing the server list at the same time wait.
	connectionRateLimit = 10

	asleepMOTD  = "Servidor dormido: conéctate para arrancarlo"
	loadingMOTD = "Arrancando el servidor…"
)

// ImageRef is the router's image with its tag and digest pinned.
func ImageRef() string { return Image + ":" + Tag + "@" + Digest }

// logConfig rotates the router's logs: it is exposed to the network and logs every connection.
func logConfig() container.LogConfig {
	return container.LogConfig{Type: "json-file", Config: map[string]string{"max-size": "10m", "max-file": "3"}}
}

// Build is the router container's configuration.
type Build struct {
	Name       string
	Config     *container.Config
	HostConfig *container.HostConfig
	Networking *network.NetworkingConfig
	Hash       string
	// AllowDeny is the content of -auto-scale-allow-deny (nil without a list) and AllowDenyPath where it must
	// be on the host before creating or starting the container (the Manager writes it).
	AllowDeny     []byte
	AllowDenyPath string
}

// Validate checks a router spec from the panel.
func Validate(sp *mcsmv1.RouterSpec) error {
	if sp == nil {
		return errors.New("router: missing spec")
	}
	if sp.HostPort < 1 || sp.HostPort > 65535 {
		return fmt.Errorf("router: host port out of range: %d", sp.HostPort)
	}
	if sp.AutoscaleDownAfterMinutes > MaxDownAfterMinutes {
		return fmt.Errorf("router: minutes without players out of range: %d (max. %d)", sp.AutoscaleDownAfterMinutes, MaxDownAfterMinutes)
	}
	if len(sp.AutoscaleAllowPlayers) > MaxAllowPlayers {
		return fmt.Errorf("router: too many players in the autoscale list: %d (max. %d)", len(sp.AutoscaleAllowPlayers), MaxAllowPlayers)
	}
	for _, p := range sp.AutoscaleAllowPlayers {
		if !spec.ValidPlayer(p) {
			return fmt.Errorf("router: invalid player in the autoscale list: %q (1-16 letters, digits or _ name, or UUID)", p)
		}
	}
	return nil
}

// allowEntry is a player in mc-router's -auto-scale-allow-deny file.
type allowEntry struct {
	Name string `json:"name,omitempty"`
	UUID string `json:"uuid,omitempty"`
}

// allowDeny returns the -auto-scale-allow-deny file: a global allow list (only they
// wake up servers or cancel their stop), or nil without autoscale or without a list. UUIDs go in their
// canonical form (8-4-4-4-12 lowercase), which is the one mc-router understands.
func allowDeny(sp *mcsmv1.RouterSpec) []byte {
	if !sp.Autoscale || len(sp.AutoscaleAllowPlayers) == 0 {
		return nil
	}
	entries := make([]allowEntry, 0, len(sp.AutoscaleAllowPlayers))
	for _, p := range sp.AutoscaleAllowPlayers {
		if h := strings.ToLower(strings.ReplaceAll(p, "-", "")); len(h) == 32 {
			entries = append(entries, allowEntry{UUID: h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]})
		} else {
			entries = append(entries, allowEntry{Name: p})
		}
	}
	type list struct {
		Allowlist []allowEntry `json:"allowlist"`
	}
	b, _ := json.Marshal(struct {
		Global list `json:"global"`
	}{list{entries}})
	return b
}

// args are mc-router's arguments. Without autoscale, mc-router only routes to running
// containers; with autoscale it starts the server when a player joins and stops it after N minutes with nobody.
// dockerSocket is the path of the proxy's socket inside the container.
func args(sp *mcsmv1.RouterSpec, dockerSocket string) []string {
	a := []string{"-in-docker", "-docker-socket", "unix://" + dockerSocket, "-port", strconv.Itoa(ListenPort),
		"-connection-rate-limit", strconv.Itoa(connectionRateLimit)}
	if sp.Autoscale {
		mins := sp.AutoscaleDownAfterMinutes
		if mins == 0 {
			mins = DefaultDownAfterMinutes
		}
		a = append(a, "-auto-scale-up", "-auto-scale-down", "-auto-scale-down-after", fmt.Sprintf("%dm", mins),
			"-auto-scale-asleep-motd", asleepMOTD, "-auto-scale-loading-motd", loadingMOTD)
	}
	return a
}

// BuildContainer translates the spec into the container configuration. Pure: same input, same Hash.
// proxySocket is the host path of the agent's Docker proxy socket (dockerproxy), whose directory is mounted
// (read-only) at RouterSocketDir, and filesDir the host directory where the agent leaves the router's files
// (the autoscale list).
func BuildContainer(sp *mcsmv1.RouterSpec, name, networkName, proxySocket, filesDir string) (*Build, error) {
	if err := Validate(sp); err != nil {
		return nil, err
	}
	if proxySocket == "" {
		return nil, errors.New("router: missing the agent's Docker proxy socket")
	}
	allow := allowDeny(sp)
	if allow != nil && filesDir == "" {
		return nil, errors.New("router: missing the host directory for the autoscale player list")
	}
	port := network.MustParsePort(fmt.Sprintf("%d/tcp", ListenPort))
	cfg := &container.Config{
		Image:        ImageRef(),
		Cmd:          args(sp, path.Join(RouterSocketDir, filepath.Base(proxySocket))),
		User:         User,
		ExposedPorts: network.PortSet{port: {}},
		Labels:       map[string]string{spec.LabelManaged: "true", LabelRouter: "true"},
	}
	host := &container.HostConfig{
		Binds:          []string{filepath.Dir(proxySocket) + ":" + RouterSocketDir + ":ro"},
		PortBindings:   network.PortMap{port: {{HostPort: strconv.FormatUint(uint64(sp.HostPort), 10)}}},
		RestartPolicy:  container.RestartPolicy{Name: container.RestartPolicyUnlessStopped},
		SecurityOpt:    []string{"no-new-privileges:true"},
		CapDrop:        []string{"ALL"},
		ReadonlyRootfs: true,
		LogConfig:      logConfig(),
	}
	host.Resources.Memory = memoryLimit
	pids := int64(pidsLimit)
	host.Resources.PidsLimit = &pids
	allowPath := ""
	if allow != nil {
		allowPath = filepath.Join(filesDir, AllowDenyFile)
		cfg.Cmd = append(cfg.Cmd, "-auto-scale-allow-deny", allowDenyMount)
		host.Binds = append(host.Binds, allowPath+":"+allowDenyMount+":ro")
	}
	net := &network.NetworkingConfig{EndpointsConfig: map[string]*network.EndpointSettings{networkName: {}}}
	hash, err := hashOf(name, networkName, cfg, host, allow)
	if err != nil {
		return nil, err
	}
	cfg.Labels[LabelHash] = hash
	return &Build{Name: name, Config: cfg, HostConfig: host, Networking: net, Hash: hash, AllowDeny: allow, AllowDenyPath: allowPath}, nil
}

// hashInput is the canonical form of what defines the router's container (not moby's JSON, which
// changes between library versions). Everything BuildContainer sets must be here.
type hashInput struct {
	Schema         int               `json:"schema"`
	Name           string            `json:"name"`
	Image          string            `json:"image"`
	Cmd            []string          `json:"cmd"`
	User           string            `json:"user"`
	Labels         map[string]string `json:"labels"`
	Ports          []string          `json:"ports"`
	Binds          []string          `json:"binds"`
	Network        string            `json:"network"`
	Restart        string            `json:"restart"`
	Memory         int64             `json:"memory"`
	PidsLimit      int64             `json:"pidsLimit"`
	SecurityOpt    []string          `json:"securityOpt"`
	CapDrop        []string          `json:"capDrop"`
	GroupAdd       []string          `json:"groupAdd"`
	ReadonlyRootfs bool              `json:"readonlyRootfs"`
	LogType        string            `json:"logType"`
	LogOpts        map[string]string `json:"logOpts"`
	AllowDeny      string            `json:"allowDeny,omitempty"` // file content: mc-router does not re-read it
}

func hashOf(name, networkName string, cfg *container.Config, host *container.HostConfig, allow []byte) (string, error) {
	in := hashInput{
		Schema: hashSchema, Name: name, Image: cfg.Image, Cmd: append([]string{}, cfg.Cmd...), User: cfg.User,
		Labels: map[string]string{}, Binds: sorted(host.Binds), Network: networkName, Restart: string(host.RestartPolicy.Name),
		Memory: host.Resources.Memory, SecurityOpt: sorted(host.SecurityOpt), CapDrop: sorted(host.CapDrop),
		GroupAdd: sorted(host.GroupAdd), ReadonlyRootfs: host.ReadonlyRootfs,
		LogType: host.LogConfig.Type, LogOpts: host.LogConfig.Config, AllowDeny: string(allow),
	}
	for k, v := range cfg.Labels {
		if k != LabelHash {
			in.Labels[k] = v
		}
	}
	for p, binds := range host.PortBindings {
		for _, b := range binds {
			in.Ports = append(in.Ports, p.String()+"->:"+b.HostPort)
		}
	}
	sort.Strings(in.Ports)
	if host.Resources.PidsLimit != nil {
		in.PidsLimit = *host.Resources.PidsLimit
	}
	b, err := json.Marshal(in)
	if err != nil {
		return "", fmt.Errorf("router: compute the hash: %w", err)
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])[:16], nil
}

func sorted(in []string) []string {
	out := append([]string{}, in...)
	sort.Strings(out)
	return out
}
