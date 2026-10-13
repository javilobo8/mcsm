package router

import (
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/moby/moby/api/types/network"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/spec"
)

func build(t *testing.T, sp *mcsmv1.RouterSpec) *Build {
	t.Helper()
	b, err := BuildContainer(sp, ContainerName, "mcsm", "/srv/minecraft/.mcsm-router/docker.sock", "/srv/minecraft/.mcsm-router")
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestBuildContainer(t *testing.T) {
	b := build(t, &mcsmv1.RouterSpec{HostPort: 25565})
	// S1: the container receives the Docker socket: the image is pinned by digest, not just by tag.
	if b.Name != "mcsm-router" || b.Config.Image != "itzg/mc-router:1.47.1@sha256:177433dd91507339924d60205a19ae9a289afd0e69dbad54e1a55d497f7523f8" || ImageRef() != b.Config.Image {
		t.Fatalf("name/image = %s %s", b.Name, b.Config.Image)
	}
	// S4: mc-router's default limit (1 connection/s, global) makes several players wait.
	// m5: mc-router's Docker client goes to the proxy socket inside the mounted directory.
	if !slices.Equal(b.Config.Cmd, []string{"-in-docker", "-docker-socket", "unix:///run/mcsm/docker.sock", "-port", "25565", "-connection-rate-limit", "10"}) {
		t.Fatalf("cmd = %v", b.Config.Cmd)
	}
	if b.Config.Labels[spec.LabelManaged] != "true" || b.Config.Labels[LabelRouter] != "true" || b.Config.Labels[LabelHash] != b.Hash {
		t.Fatalf("labels = %v", b.Config.Labels)
	}
	if _, ok := b.Config.Labels[spec.LabelServerID]; ok {
		t.Fatal("the router is not a server: no mcsm.server_id")
	}
	binds := b.HostConfig.PortBindings
	if len(binds) != 1 || binds[network.MustParsePort("25565/tcp")][0].HostPort != "25565" {
		t.Fatalf("ports = %v", binds)
	}
	if _, ok := b.Networking.EndpointsConfig["mcsm"]; !ok {
		t.Fatal("the router goes on the servers' network")
	}
}

func TestBuildContainerHardening(t *testing.T) {
	h := build(t, &mcsmv1.RouterSpec{HostPort: 25565}).HostConfig
	// m5: the socket's DIRECTORY, not the file: a new socket (the agent restarts) is another inode, and with the
	// file mounted the router would stay on the old one; if it were missing at boot, Docker would create a directory at its
	// path.
	if !slices.Equal(h.Binds, []string{"/srv/minecraft/.mcsm-router:/run/mcsm:ro"}) {
		t.Fatalf("binds = %v: only the agent proxy's socket directory, never Docker's socket", h.Binds)
	}
	if !slices.Equal(h.CapDrop, []string{"ALL"}) || len(h.CapAdd) != 0 {
		t.Fatalf("caps = %v %v", h.CapDrop, h.CapAdd)
	}
	if !slices.Equal(h.SecurityOpt, []string{"no-new-privileges:true"}) || !h.ReadonlyRootfs || h.Privileged {
		t.Fatalf("security = %v ro=%v priv=%v", h.SecurityOpt, h.ReadonlyRootfs, h.Privileged)
	}
	if len(h.GroupAdd) != 0 {
		t.Fatalf("groupAdd = %v: the proxy's socket belongs to the router's user", h.GroupAdd)
	}
	if h.Resources.Memory != 256<<20 || h.Resources.PidsLimit == nil || *h.Resources.PidsLimit != 256 {
		t.Fatal("memory and process limits")
	}
	if h.RestartPolicy.Name != "unless-stopped" {
		t.Fatalf("restart = %v", h.RestartPolicy)
	}
	// S5: exposed to the network and logs every connection: logs with rotation.
	if h.LogConfig.Type != "json-file" || h.LogConfig.Config["max-size"] != "10m" || h.LogConfig.Config["max-file"] != "3" {
		t.Fatalf("logs = %+v", h.LogConfig)
	}
	if u := build(t, &mcsmv1.RouterSpec{HostPort: 25565}).Config.User; u != "65532:65532" {
		t.Fatalf("user = %q: not root", u)
	}
}

func TestBuildContainerAutoscale(t *testing.T) {
	cmd := build(t, &mcsmv1.RouterSpec{HostPort: 25565, Autoscale: true}).Config.Cmd
	joined := strings.Join(cmd, " ")
	for _, want := range []string{"-auto-scale-up", "-auto-scale-down", "-auto-scale-down-after 10m", "-auto-scale-asleep-motd"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("cmd = %v: missing %s", cmd, want)
		}
	}
	cmd = build(t, &mcsmv1.RouterSpec{HostPort: 25565, Autoscale: true, AutoscaleDownAfterMinutes: 30}).Config.Cmd
	if !strings.Contains(strings.Join(cmd, " "), "-auto-scale-down-after 30m") {
		t.Fatalf("cmd = %v", cmd)
	}
	// Minutes without autoscale change nothing (nor the hash).
	a := build(t, &mcsmv1.RouterSpec{HostPort: 25565})
	b := build(t, &mcsmv1.RouterSpec{HostPort: 25565, AutoscaleDownAfterMinutes: 30})
	if a.Hash != b.Hash {
		t.Fatal("without autoscale, the minutes do not count")
	}
}

func TestBuildContainerHash(t *testing.T) {
	base := build(t, &mcsmv1.RouterSpec{HostPort: 25565})
	if again := build(t, &mcsmv1.RouterSpec{HostPort: 25565}); again.Hash != base.Hash {
		t.Fatal("the hash must be stable")
	}
	for name, other := range map[string]*Build{
		"port":      build(t, &mcsmv1.RouterSpec{HostPort: 25570}),
		"autoscale": build(t, &mcsmv1.RouterSpec{HostPort: 25565, Autoscale: true}),
	} {
		if other.Hash == base.Hash {
			t.Errorf("%s must change the hash", name)
		}
	}
	sock, err := BuildContainer(&mcsmv1.RouterSpec{HostPort: 25565}, ContainerName, "mcsm", "/other/docker.sock", "/srv/minecraft/.mcsm-router")
	if err != nil || sock.Hash == base.Hash {
		t.Error("the socket path must change the hash")
	}
	net, err := BuildContainer(&mcsmv1.RouterSpec{HostPort: 25565}, ContainerName, "other", "/srv/minecraft/.mcsm-router/docker.sock", "/srv/minecraft/.mcsm-router")
	if err != nil || net.Hash == base.Hash {
		t.Error("the network must change the hash")
	}
}

func TestValidate(t *testing.T) {
	many := make([]string, 1001)
	for i := range many {
		many[i] = "p" + strconv.Itoa(i)
	}
	for _, bad := range []*mcsmv1.RouterSpec{nil, {}, {HostPort: 70000}, {HostPort: 25565, AutoscaleDownAfterMinutes: 1441},
		{HostPort: 25565, Autoscale: true, AutoscaleAllowPlayers: []string{"a b"}},
		{HostPort: 25565, Autoscale: true, AutoscaleAllowPlayers: []string{"too_long_player_17"}},
		{HostPort: 25565, Autoscale: true, AutoscaleAllowPlayers: many}} {
		if err := Validate(bad); err == nil {
			t.Errorf("%v should be invalid", bad)
		}
		if _, err := BuildContainer(bad, ContainerName, "mcsm", "/x/docker.sock", ""); err == nil {
			t.Errorf("BuildContainer(%v) should fail", bad)
		}
	}
	if err := Validate(&mcsmv1.RouterSpec{HostPort: 1, AutoscaleDownAfterMinutes: 1440}); err != nil {
		t.Fatal(err)
	}
}

// S3: with autoscale, anyone who reaches the port wakes up servers. A list of players
// (name or UUID) limits who wakes them: mc-router reads it from a file (-auto-scale-allow-deny)
// that the agent writes on the host and mounts read-only.
func TestBuildContainerAllowDeny(t *testing.T) {
	sp := &mcsmv1.RouterSpec{HostPort: 25565, Autoscale: true, AutoscaleAllowPlayers: []string{"amigo", "0123456789ABCDEF0123456789abcdef"}}
	b := build(t, sp)
	if !strings.Contains(strings.Join(b.Config.Cmd, " "), "-auto-scale-allow-deny /etc/mc-router/allow-deny.json") {
		t.Fatalf("cmd = %v", b.Config.Cmd)
	}
	if !slices.Contains(b.HostConfig.Binds, "/srv/minecraft/.mcsm-router/allow-deny.json:/etc/mc-router/allow-deny.json:ro") || len(b.HostConfig.Binds) != 2 {
		t.Fatalf("binds = %v", b.HostConfig.Binds)
	}
	want := `{"global":{"allowlist":[{"name":"amigo"},{"uuid":"01234567-89ab-cdef-0123-456789abcdef"}]}}`
	if string(b.AllowDeny) != want || b.AllowDenyPath != "/srv/minecraft/.mcsm-router/allow-deny.json" {
		t.Fatalf("allow-deny = %s en %s", b.AllowDeny, b.AllowDenyPath)
	}
	other := build(t, &mcsmv1.RouterSpec{HostPort: 25565, Autoscale: true, AutoscaleAllowPlayers: []string{"amigo"}})
	if other.Hash == b.Hash {
		t.Fatal("changing the list recreates the router (mc-router does not re-read the file)")
	}
	// Without autoscale the list does not count (nor the hash); with autoscale and without a list, no file.
	plain := build(t, &mcsmv1.RouterSpec{HostPort: 25565})
	ignored := build(t, &mcsmv1.RouterSpec{HostPort: 25565, AutoscaleAllowPlayers: []string{"amigo"}})
	if ignored.Hash != plain.Hash || ignored.AllowDeny != nil {
		t.Fatal("without autoscale the list is ignored")
	}
	if open := build(t, &mcsmv1.RouterSpec{HostPort: 25565, Autoscale: true}); open.AllowDeny != nil || len(open.HostConfig.Binds) != 1 {
		t.Fatalf("without a list: %+v", open.HostConfig.Binds)
	}
	if _, err := BuildContainer(sp, ContainerName, "mcsm", "/x/docker.sock", ""); err == nil {
		t.Fatal("with a list the host directory is needed")
	}
}

func TestBuildContainerNeedsProxySocket(t *testing.T) {
	if _, err := BuildContainer(&mcsmv1.RouterSpec{HostPort: 25565}, ContainerName, "mcsm", "", "/x"); err == nil {
		t.Fatal("without the proxy socket there is no router")
	}
}
