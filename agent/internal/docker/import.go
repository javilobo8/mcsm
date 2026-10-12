package docker

import "sort"

// ImportInfo es el inspect reducido de un contenedor que se puede importar (spec §6.7).
type ImportInfo struct {
	ID          string
	Name        string
	Image       string // Config.Image tal cual la escribió el usuario
	ImageID     string // imagen con la que corre (sha256:… en Docker)
	State       string
	Env         []string
	Labels      map[string]string
	Ports       []PortPublish // publicaciones configuradas (HostConfig.PortBindings), ordenadas
	Mounts      []Mount
	Restart     string
	Memory      int64 // límite de memoria; 0 = sin límite
	NanoCPUs    int64
	NetworkMode string
	Networks    []string // redes a las que está conectado, ordenadas
	// Aliases: alias DNS que puso el usuario en cada red (sin el nombre ni el id del contenedor);
	// nil si no hay ninguno.
	Aliases map[string][]string
}

// PortPublish es una publicación de puerto. HostIP "" = todas las interfaces; HostPort 0 = efímero.
type PortPublish struct {
	ContainerPort int
	Proto         string
	HostIP        string
	HostPort      int
}

// Mount es un montaje del contenedor. Source es la ruta del host (bind) o del volumen.
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
