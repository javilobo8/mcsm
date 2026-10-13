package app

import (
	"context"
	"testing"
)

func TestHelloReportsTheDockerHostName(t *testing.T) {
	a, _, _ := newApp(t)
	h := a.hello(context.Background())
	if h.GetHost().GetHostname() != "fake-host" {
		t.Fatalf("hostname = %q: it must be the Docker host's, not the agent container's", h.GetHost().GetHostname())
	}
	if h.GetAgentVersion() != "test" {
		t.Fatalf("version = %q", h.GetAgentVersion())
	}
}
