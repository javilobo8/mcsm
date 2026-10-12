package store

import (
	"path/filepath"
	"testing"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
)

func TestRouterSpecRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "a.db")
	st, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if sp, err := st.RouterSpec(); err != nil || sp != nil {
		t.Fatalf("sin router: %v %v", sp, err)
	}
	if err := st.DeleteRouterSpec(); err != nil {
		t.Fatalf("borrar sin bucket es idempotente: %v", err)
	}
	if err := st.PutRouterSpec(nil); err == nil {
		t.Fatal("una spec nil no se guarda")
	}
	if err := st.PutRouterSpec(&mcsmv1.RouterSpec{HostPort: 25565, Autoscale: true, AutoscaleDownAfterMinutes: 15}); err != nil {
		t.Fatal(err)
	}
	if err := st.PutRouterSpec(&mcsmv1.RouterSpec{HostPort: 25570}); err != nil {
		t.Fatal(err)
	}
	st.Close()

	// Sobrevive a un reinicio del agente.
	st, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	sp, err := st.RouterSpec()
	if err != nil || sp.GetHostPort() != 25570 || sp.GetAutoscale() {
		t.Fatalf("spec = %v, %v", sp, err)
	}
	if err := st.DeleteRouterSpec(); err != nil {
		t.Fatal(err)
	}
	if sp, _ := st.RouterSpec(); sp != nil {
		t.Fatalf("tras borrar: %v", sp)
	}
}
