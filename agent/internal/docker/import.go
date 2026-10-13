package docker

import "sort"

// ImportInfo is the reduced inspect of a container that can be imported (spec §6.7).
type ImportInfo struct {
	ID          string
	Name        string
	Image       string // Config.Image exactly as the user wrote it
	ImageID     string // image it runs with (sha256:… in Docker)
	State       string
	User        string // Config.User (--user): "" = the image's
	Env         []string
	Labels      map[string]string
	Ports       []PortPublish // configured publications (HostConfig.PortBindings), sorted
	Mounts      []Mount
	Restart     string
	Memory      int64 // memory limit; 0 = no limit
	NanoCPUs    int64
	NetworkMode string
	Networks    []string // networks it is connected to, sorted
	// Aliases: DNS aliases the user set on each network (without the container's name or id);
	// nil if there are none.
	Aliases map[string][]string
}

// PortPublish is a port publication. HostIP "" = all interfaces; HostPort 0 = ephemeral.
type PortPublish struct {
	ContainerPort int
	Proto         string
	HostIP        string
	HostPort      int
}

// Mount is a container mount. Source is the host path (bind) or the volume's.
type Mount struct {
	Type        string
	Source      string
	Destination string
	Name        string
	RW          bool
}

func sortPorts(ps []PortPublish) {
	sort.Slice(ps, func(i, j int) bool {
		a, b := ps[i], ps[j]
		if a.ContainerPort != b.ContainerPort {
			return a.ContainerPort < b.ContainerPort
		}
		if a.Proto != b.Proto {
			return a.Proto < b.Proto
		}
		if a.HostPort != b.HostPort {
			return a.HostPort < b.HostPort
		}
		return a.HostIP < b.HostIP
	})
}
