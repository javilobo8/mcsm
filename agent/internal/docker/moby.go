package docker

import (
	"context"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"

	cerrdefs "github.com/containerd/errdefs"
	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
	"github.com/moby/moby/client"
)

// Moby implementa Engine sobre github.com/moby/moby/client.
type Moby struct{ cli *client.Client }

func NewMoby() (*Moby, error) {
	cli, err := client.New(client.FromEnv)
	if err != nil {
		return nil, fmt.Errorf("docker: crear cliente: %w", err)
	}
	return &Moby{cli: cli}, nil
}

func (m *Moby) Version(ctx context.Context) (string, error) {
	v, err := m.cli.ServerVersion(ctx, client.ServerVersionOptions{})
	if err != nil {
		return "", err
	}
	return v.Version, nil
}

func (m *Moby) EnsureNetwork(ctx context.Context, name string) error {
	if _, err := m.cli.NetworkInspect(ctx, name, client.NetworkInspectOptions{}); err == nil {
		return nil
	} else if !cerrdefs.IsNotFound(err) {
		return err
	}
	_, err := m.cli.NetworkCreate(ctx, name, client.NetworkCreateOptions{Driver: "bridge"})
	return err
}

func (m *Moby) EnsureImage(ctx context.Context, ref string) error {
	if _, err := m.cli.ImageInspect(ctx, ref); err == nil {
		return nil
	} else if !cerrdefs.IsNotFound(err) {
		return err
	}
	resp, err := m.cli.ImagePull(ctx, ref, client.ImagePullOptions{})
	if err != nil {
		return fmt.Errorf("docker: pull %s: %w", ref, err)
	}
	defer resp.Close()
	return resp.Wait(ctx)
}

func (m *Moby) ListManaged(ctx context.Context) ([]Container, error) {
	res, err := m.cli.ContainerList(ctx, client.ContainerListOptions{
		All:     true,
		Filters: client.Filters{}.Add("label", "mcsm.managed=true"),
	})
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

func (m *Moby) Inspect(ctx context.Context, id string) (*Inspect, error) {
	res, err := m.cli.ContainerInspect(ctx, id, client.ContainerInspectOptions{})
	if err != nil {
		if cerrdefs.IsNotFound(err) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	c := res.Container
	out := &Inspect{ID: c.ID, Name: strings.TrimPrefix(c.Name, "/")}
	if c.Config != nil {
		out.Labels = c.Config.Labels
	}
	if c.State != nil {
		out.State = string(c.State.Status)
		out.Running = c.State.Running
		out.ExitCode = c.State.ExitCode
		if c.State.Health != nil {
			out.Health = string(c.State.Health.Status)
		}
		if t, err := time.Parse(time.RFC3339Nano, c.State.StartedAt); err == nil && t.Unix() > 0 {
			out.StartedAt = t
		}
	}
	return out, nil
}

func (m *Moby) Create(ctx context.Context, name string, cfg *container.Config, host *container.HostConfig, net *network.NetworkingConfig) (string, error) {
	res, err := m.cli.ContainerCreate(ctx, client.ContainerCreateOptions{Name: name, Config: cfg, HostConfig: host, NetworkingConfig: net})
	if err != nil {
		return "", err
	}
	return res.ID, nil
}

func (m *Moby) Start(ctx context.Context, id string) error {
	_, err := m.cli.ContainerStart(ctx, id, client.ContainerStartOptions{})
	return notFound(err)
}

func (m *Moby) Stop(ctx context.Context, id string, timeout time.Duration) error {
	secs := int(timeout.Seconds())
	_, err := m.cli.ContainerStop(ctx, id, client.ContainerStopOptions{Timeout: &secs})
	return notFound(err)
}

func (m *Moby) Kill(ctx context.Context, id string) error {
	_, err := m.cli.ContainerKill(ctx, id, client.ContainerKillOptions{Signal: "SIGKILL"})
	return notFound(err)
}

func (m *Moby) Remove(ctx context.Context, id string) error {
	_, err := m.cli.ContainerRemove(ctx, id, client.ContainerRemoveOptions{Force: true})
	return notFound(err)
}

func (m *Moby) Logs(ctx context.Context, id string, tail int) (io.ReadCloser, error) {
	rc, err := m.cli.ContainerLogs(ctx, id, client.ContainerLogsOptions{
		ShowStdout: true, ShowStderr: true, Follow: true, Timestamps: true, Tail: strconv.Itoa(tail),
	})
	if err != nil {
		return nil, notFound(err)
	}
	return rc, nil
}

// Events emite eventos de contenedores con la etiqueta mcsm.managed=true. El canal
// de eventos se cierra cuando termina la goroutine (ctx cancelado, error del
// daemon o stream cerrado). El canal de errores no se cierra: recibe como mucho un
// error, que incluye context.Canceled si ctx se cancela mientras se espera; el
// consumidor debe ignorarlo en ese caso. Ningún envío bloquea más allá de ctx.
func (m *Moby) Events(ctx context.Context) (<-chan Event, <-chan error) {
	res := m.cli.Events(ctx, client.EventsListOptions{
		Filters: client.Filters{}.Add("type", "container").Add("label", "mcsm.managed=true"),
	})
	out := make(chan Event, 32)
	errs := make(chan error, 1)
	go func() {
		defer close(out)
		for {
			select {
			case <-ctx.Done():
				return
			case err := <-res.Err:
				if err != nil {
					select {
					case errs <- err:
					case <-ctx.Done():
					}
				}
				return
			case msg, ok := <-res.Messages:
				if !ok {
					return
				}
				ev := Event{Action: string(msg.Action), ContainerID: msg.Actor.ID, Labels: msg.Actor.Attributes}
				select {
				case out <- ev:
				case <-ctx.Done():
					return
				}
			}
		}
	}()
	return out, errs
}

func notFound(err error) error {
	if err != nil && cerrdefs.IsNotFound(err) {
		return ErrNotFound
	}
	return err
}
