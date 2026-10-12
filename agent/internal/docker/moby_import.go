package docker

import (
	"context"
	"sort"
	"strconv"
	"strings"

	"github.com/moby/moby/api/types/network"
	"github.com/moby/moby/client"
)

func (m *Moby) ListAll(ctx context.Context) ([]Container, error) {
	res, err := m.cli.ContainerList(ctx, client.ContainerListOptions{All: true})
	if err != nil {
		return nil, err
	}
	out := make([]Container, 0, len(res.Items))
	for _, c := range res.Items {
		name := ""
		if len(c.Names) > 0 {
			name = strings.TrimPrefix(c.Names[0], "/")
		}
		out = append(out, Container{ID: c.ID, Name: name, State: string(c.State), Labels: c.Labels})
	}
	return out, nil
}

func (m *Moby) InspectImport(ctx context.Context, id string) (*ImportInfo, error) {
	res, err := m.cli.ContainerInspect(ctx, id, client.ContainerInspectOptions{})
	if err != nil {
		return nil, notFound(err)
	}
	c := res.Container
	out := &ImportInfo{ID: c.ID, Name: strings.TrimPrefix(c.Name, "/"), ImageID: c.Image, Labels: map[string]string{}}
	if c.State != nil {
		out.State = string(c.State.Status)
	}
	if c.Config != nil {
		out.Image = c.Config.Image
		out.User = c.Config.User
		out.Env = c.Config.Env
		if c.Config.Labels != nil {
			out.Labels = c.Config.Labels
		}
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
	}
	for _, mp := range c.Mounts {
		out.Mounts = append(out.Mounts, Mount{Type: string(mp.Type), Source: mp.Source, Destination: mp.Destination, Name: mp.Name, RW: mp.RW})
	}
	if c.NetworkSettings != nil {
		for name, ep := range c.NetworkSettings.Networks {
			out.Networks = append(out.Networks, name)
			if ep != nil && len(ep.Aliases) > 0 {
				if out.Aliases == nil {
					out.Aliases = map[string][]string{}
				}
				out.Aliases[name] = ep.Aliases
			}
		}
	}
	sort.Strings(out.Networks)
	sortPorts(out.Ports)
	return out, nil
}

func (m *Moby) ImageEnv(ctx context.Context, image string) ([]string, error) {
	res, err := m.cli.ImageInspect(ctx, image)
	if err != nil {
		return nil, notFound(err)
	}
	if res.Config == nil {
		return nil, nil
	}
	return res.Config.Env, nil
}

func (m *Moby) ConnectNetwork(ctx context.Context, netName, id string, aliases []string) error {
	_, err := m.cli.NetworkConnect(ctx, netName, client.NetworkConnectOptions{
		Container: id, EndpointConfig: &network.EndpointSettings{Aliases: aliases},
	})
	return notFound(err)
}

func (m *Moby) DisconnectNetwork(ctx context.Context, netName, id string) error {
	_, err := m.cli.NetworkDisconnect(ctx, netName, client.NetworkDisconnectOptions{Container: id})
	return notFound(err)
}
