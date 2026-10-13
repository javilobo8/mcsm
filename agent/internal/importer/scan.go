// Package importer describes the foreign itzg containers that can be imported (spec §6.7).
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

// Engine is what the import uses from Docker (docker.Engine satisfies it).
type Engine interface {
	ListAll(ctx context.Context) ([]docker.Container, error)
	InspectImport(ctx context.Context, id string) (*docker.ImportInfo, error)
	ImageEnv(ctx context.Context, image string) ([]string, error)
}

var _ Engine = docker.Engine(nil)

// composeLabels are the only labels sent to the panel (warns that Compose would recreate it).
var composeLabels = []string{"com.docker.compose.project", "com.docker.compose.service"}

// Scan returns the import candidates, sorted by name: containers with the itzg/minecraft-server
// image, without the mcsm.managed label and that skip does not discard (those already adopted). If
// the image ENV cannot be read, the env is returned in full. It never logs the env (it carries secrets).
func Scan(ctx context.Context, eng Engine, skip func(containerID string) bool) ([]*mcsmv1.ImportCandidate, error) {
	list, err := eng.ListAll(ctx)
	if err != nil {
		return nil, fmt.Errorf("list containers: %w", err)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].Name < list[j].Name })
	var out []*mcsmv1.ImportCandidate
	for _, c := range list {
		if c.Labels[spec.LabelManaged] == "true" || skip(c.ID) {
			continue
		}
		info, err := eng.InspectImport(ctx, c.ID)
		if errors.Is(err, docker.ErrNotFound) {
			continue // deleted between the list and the inspect
		}
		if err != nil {
			return nil, fmt.Errorf("inspect %s: %w", c.Name, err)
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

// UserEnv returns the container env without the entries identical to the image ENV: what
// the user set. An image variable with a different value does belong to the user.
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

// valid sanitizes container text: proto3 rejects strings with invalid UTF-8 and the whole message would be lost.
func valid(s string) string { return strings.ToValidUTF8(s, "�") }

func candidate(info *docker.ImportInfo, env map[string]string) *mcsmv1.ImportCandidate {
	c := &mcsmv1.ImportCandidate{
		ContainerId: info.ID, Name: valid(info.Name), Image: valid(info.Image), State: info.State, User: valid(info.User),
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
