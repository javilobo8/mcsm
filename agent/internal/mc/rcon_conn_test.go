package mc

import (
	"context"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestRconConnReusesOneConnection(t *testing.T) {
	var accepted atomic.Int32
	host, port := startFakeRcon(t, "secret", &accepted)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, err := DialRcon(ctx, host, port, "secret")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	for _, cmd := range []string{"tps", "list", "tps"} {
		out, err := c.Command(ctx, cmd)
		if err != nil {
			t.Fatal(err)
		}
		if out != "ok:"+cmd {
			t.Fatalf("out = %q", out)
		}
	}
	if n := accepted.Load(); n != 1 {
		t.Fatalf("conexiones = %d, want 1", n)
	}
}

func TestRconConnWrongPassword(t *testing.T) {
	host, port := fakeRcon(t, "secret")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := DialRcon(ctx, host, port, "mala"); err == nil || !strings.Contains(err.Error(), "contraseña incorrecta") {
		t.Fatalf("err = %v", err)
	}
}

func TestRconConnClosedAfterError(t *testing.T) {
	host, port := fakeRcon(t, "secret")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, err := DialRcon(ctx, host, port, "secret")
	if err != nil {
		t.Fatal(err)
	}
	_ = c.conn.Close() // la conexión se rompe (servidor reiniciado)
	if _, err := c.Command(ctx, "tps"); err == nil {
		t.Fatal("esperaba error con la conexión rota")
	}
	if _, err := c.Command(ctx, "tps"); err == nil || !strings.Contains(err.Error(), "sesión cerrada") {
		t.Fatalf("tras un error la sesión debe quedar cerrada: %v", err)
	}
	if err := c.Close(); err != nil {
		t.Fatalf("Close idempotente: %v", err)
	}
}

func TestRconDeadlinePolicy(t *testing.T) {
	now := time.Now()
	long, cancel := context.WithDeadline(context.Background(), now.Add(30*time.Second))
	defer cancel()
	short, cancel2 := context.WithDeadline(context.Background(), now.Add(time.Second))
	defer cancel2()
	if d := rconDeadline(context.Background(), now); !d.Equal(now.Add(rconTimeout)) {
		t.Fatalf("sin deadline: %v", d)
	}
	if d := rconDeadline(long, now); !d.Equal(now.Add(30 * time.Second)) {
		t.Fatalf("deadline largo del llamador debe respetarse: %v", d)
	}
	if d := rconDeadline(short, now); !d.Equal(now.Add(time.Second)) {
		t.Fatalf("deadline corto: %v", d)
	}
}
