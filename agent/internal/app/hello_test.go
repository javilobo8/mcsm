package app

import (
	"context"
	"testing"
)

func TestHelloReportsTheDockerHostName(t *testing.T) {
	a, _, _ := newApp(t)
	h := a.hello(context.Background())
	if h.GetHost().GetHostname() != "fake-host" {
		t.Fatalf("hostname = %q: debe ser el del host de Docker, no el del contenedor del agente", h.GetHost().GetHostname())
	}
	if h.GetAgentVersion() != "test" {
		t.Fatalf("versión = %q", h.GetAgentVersion())
	}
}
