package docker

import (
	"context"
	"fmt"
	"slices"
	"sort"
	"strconv"
	"strings"

	"github.com/moby/moby/api/types/network"
)

// ListAll returns all the containers, sorted by id. Like Inspect, it is not recorded in Calls.
func (f *Fake) ListAll(context.Context) ([]Container, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]Container, 0, len(f.Containers))
	for _, c := range f.Containers {
		labels := map[string]string{}
		if c.Config != nil {
			labels = copyLabels(c.Config.Labels)
		}
		out = append(out, Container{ID: c.ID, Name: c.Name, State: c.State, Labels: labels})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

// InspectImport translates the configuration stored in Create (and the networks from ConnectNetwork).
// In the fake, ImageID is the image reference. It is not recorded in Calls.
func (f *Fake) InspectImport(_ context.Context, id string) (*ImportInfo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	c, ok := f.Containers[id]
	if !ok {
		return nil, ErrNotFound
	}
	out := &ImportInfo{ID: c.ID, Name: c.Name, State: c.State, Labels: map[string]string{}}
	if c.Config != nil {
		out.Image, out.ImageID = c.Config.Image, c.Config.Image
		out.User = c.Config.User
		out.Env = append([]string(nil), c.Config.Env...)
		out.Labels = copyLabels(c.Config.Labels)
	}
	if hc := c.HostConfig; hc != nil {
		out.Restart = string(hc.RestartPolicy.Name)
		out.Memory = hc.Resources.Memory
		out.NanoCPUs = hc.Resources.NanoCPUs
		out.NetworkMode = string(hc.NetworkMode)
		for p, binds := range hc.PortBindings {
			for _, b := range binds {
				hp, _ := strconv.Atoi(b.HostPort)
				ip := ""
				if b.HostIP.IsValid() && !b.HostIP.IsUnspecified() {
					ip = b.HostIP.String()
				}
				out.Ports = append(out.Ports, PortPublish{ContainerPort: int(p.Num()), Proto: string(p.Proto()), HostIP: ip, HostPort: hp})
			}
		}
		for _, bind := range hc.Binds {
			parts := strings.Split(bind, ":")
			if len(parts) < 2 {
				continue
			}
			rw := len(parts) < 3 || !slices.Contains(strings.Split(parts[2], ","), "ro")
			out.Mounts = append(out.Mounts, Mount{Type: "bind", Source: parts[0], Destination: parts[1], RW: rw})
		}
		for _, m := range hc.Mounts {
			mt := Mount{Type: string(m.Type), Source: m.Source, Destination: m.Target, RW: !m.ReadOnly}
			if mt.Type == "volume" {
				mt.Name = m.Source
			}
			out.Mounts = append(out.Mounts, mt)
		}
	}
	nets := map[string]bool{}
	addAliases := func(n string, as []string) {
		if len(as) == 0 {
			return
		}
		if out.Aliases == nil {
			out.Aliases = map[string][]string{}
		}
		out.Aliases[n] = append([]string(nil), as...)
	}
	if c.Net != nil {
		for n, ep := range c.Net.EndpointsConfig {
			nets[n] = true
			if ep != nil {
				addAliases(n, ep.Aliases)
			}
		}
	}
	for n, as := range c.Aliases {
		nets[n] = true
		addAliases(n, as)
	}
	for n := range nets {
		out.Networks = append(out.Networks, n)
	}
	sort.Strings(out.Networks)
	sortPorts(out.Ports)
	return out, nil
}

// ImageEnv returns the ENV set in ImageEnvs for that reference. It is not recorded in Calls.
func (f *Fake) ImageEnv(_ context.Context, image string) ([]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	env, ok := f.ImageEnvs[image]
	if !ok {
		return nil, ErrNotFound
	}
	return append([]string(nil), env...), nil
}

// ConnectNetwork imitates Docker: connecting twice to the same network is an error.
func (f *Fake) ConnectNetwork(_ context.Context, netName, id string, aliases []string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.record("ConnectNetwork %s %s %s", netName, id, strings.Join(aliases, ","))
	if f.ConnectErr != nil {
		return f.ConnectErr
	}
	c, ok := f.Containers[id]
	if !ok {
		return ErrNotFound
	}
	_, viaAlias := c.Aliases[netName]
	viaCreate := false
	if c.Net != nil {
		_, viaCreate = c.Net.EndpointsConfig[netName]
	}
	if viaAlias || viaCreate {
		return fmt.Errorf("endpoint with name %s already exists in network %s", c.Name, netName)
	}
	if c.Aliases == nil {
		c.Aliases = map[string][]string{}
	}
	c.Aliases[netName] = append([]string(nil), aliases...)
	return nil
}

// DisconnectNetwork imitates Docker: disconnecting from a network it is not connected to is an error.
func (f *Fake) DisconnectNetwork(_ context.Context, netName, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.record("DisconnectNetwork %s %s", netName, id)
	c, ok := f.Containers[id]
	if !ok {
		return ErrNotFound
	}
	_, viaAlias := c.Aliases[netName]
	viaCreate := false
	if c.Net != nil {
		_, viaCreate = c.Net.EndpointsConfig[netName]
	}
	if !viaAlias && !viaCreate {
		return fmt.Errorf("container %s is not connected to network %s", c.Name, netName)
	}
	delete(c.Aliases, netName)
	if viaCreate {
		eps := make(map[string]*network.EndpointSettings, len(c.Net.EndpointsConfig))
		for n, ep := range c.Net.EndpointsConfig {
			if n != netName {
				eps[n] = ep
			}
		}
		c.Net = &network.NetworkingConfig{EndpointsConfig: eps} // copy: does not touch the caller's config
	}
	return nil
}
