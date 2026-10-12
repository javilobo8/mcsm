// Package importer describe los contenedores itzg ajenos que se pueden importar (spec §6.7).
package importer

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/docker"
	"mcsm/agent/internal/spec"
)

// Engine es lo que la importación usa de Docker (docker.Engine lo cumple).
type Engine interface {
	ListAll(ctx context.Context) ([]docker.Container, error)
	InspectImport(ctx context.Context, id string) (*docker.ImportInfo, error)
	ImageEnv(ctx context.Context, image string) ([]string, error)
}

var _ Engine = docker.Engine(nil)

// composeLabels son las únicas etiquetas que viajan al panel (avisa de que Compose lo recrearía).
var composeLabels = []string{"com.docker.compose.project", "com.docker.compose.service"}

// Scan devuelve los candidatos a importar, ordenados por nombre: contenedores con la imagen
// itzg/minecraft-server, sin la etiqueta mcsm.managed y que skip no descarte (los ya adoptados). Si
// no se puede leer el ENV de la imagen, el env va completo. Nunca registra el env (lleva secretos).
func Scan(ctx context.Context, eng Engine, skip func(containerID string) bool) ([]*mcsmv1.ImportCandidate, error) {
	list, err := eng.ListAll(ctx)
	if err != nil {
		return nil, fmt.Errorf("listar contenedores: %w", err)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].Name < list[j].Name })
	var out []*mcsmv1.ImportCandidate
	for _, c := range list {
		if c.Labels[spec.LabelManaged] == "true" || skip(c.ID) {
			continue
		}
		info, err := eng.InspectImport(ctx, c.ID)
		if errors.Is(err, docker.ErrNotFound) {
			continue // borrado entre la lista y el inspect
		}
		if err != nil {
			return nil, fmt.Errorf("inspeccionar %s: %w", c.Name, err)
		}
		if !spec.IsItzgImage(info.Image) || info.Labels[spec.LabelManaged] == "true" {
			continue
		}
		imageEnv, err := eng.ImageEnv(ctx, info.ImageID)
		if err != nil {
			imageEnv = nil
		}
		out = append(out, candidate(info, UserEnv(info.Env, imageEnv)))
	}
	return out, nil
}

// UserEnv devuelve el env del contenedor sin las entradas idénticas a las del ENV de la imagen: lo
// que fijó el usuario. Una variable de la imagen con otro valor sí es del usuario.
func UserEnv(containerEnv, imageEnv []string) map[string]string {
	defaults := make(map[string]bool, len(imageEnv))
	for _, e := range imageEnv {
		defaults[e] = true
	}
	out := map[string]string{}
	for _, e := range containerEnv {
		if defaults[e] {
			continue
		}
		k, v, ok := strings.Cut(e, "=")
		if !ok || k == "" {
			continue
		}
		out[k] = v
	}
	return out
}

// valid sanea texto del contenedor: proto3 rechaza string con UTF-8 inválido y el mensaje entero se perdería.
func valid(s string) string { return strings.ToValidUTF8(s, "�") }

func candidate(info *docker.ImportInfo, env map[string]string) *mcsmv1.ImportCandidate {
	c := &mcsmv1.ImportCandidate{
		ContainerId: info.ID, Name: valid(info.Name), Image: valid(info.Image), State: info.State,
		Env: make(map[string]string, len(env)), RestartPolicy: info.Restart, MemoryLimitBytes: info.Memory,
		NanoCpus: info.NanoCPUs, NetworkMode: valid(info.NetworkMode), Labels: map[string]string{},
	}
	for k, v := range env {
		c.Env[valid(k)] = valid(v)
	}
	for _, k := range composeLabels {
		if v, ok := info.Labels[k]; ok {
			c.Labels[k] = valid(v)
		}
	}
	for _, n := range info.Networks {
		c.Networks = append(c.Networks, valid(n))
	}
	for _, p := range info.Ports {
		c.Ports = append(c.Ports, &mcsmv1.ImportPort{ContainerPort: uint32(p.ContainerPort), Proto: p.Proto, HostIp: p.HostIP, HostPort: uint32(p.HostPort)})
	}
	for _, m := range info.Mounts {
		c.Mounts = append(c.Mounts, &mcsmv1.ImportMount{Type: m.Type, Source: valid(m.Source), Destination: valid(m.Destination), ReadWrite: m.RW, Name: valid(m.Name)})
	}
	return c
}
