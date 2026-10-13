package mc

import (
	"context"
	"encoding/binary"
	"io"
	"net"
	"strconv"
	"sync/atomic"
	"testing"
	"time"
)

func splitAddr(t *testing.T, ln net.Listener) (string, uint16) {
	t.Helper()
	_, p, _ := net.SplitHostPort(ln.Addr().String())
	n, _ := strconv.Atoi(p)
	return "127.0.0.1", uint16(n)
}

// fakeRcon implements just enough of the Source RCON protocol:
// packet = int32 length, int32 id, int32 type, body\0, \0
func fakeRcon(t *testing.T, password string) (host string, port uint16) {
	t.Helper()
	return startFakeRcon(t, password, nil)
}

// startFakeRcon is fakeRcon counting the accepted connections in accepted (if not nil).
func startFakeRcon(t *testing.T, password string, accepted *atomic.Int32) (host string, port uint16) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			if accepted != nil {
				accepted.Add(1)
			}
			go func(c net.Conn) {
				defer c.Close()
				authed := false
				for {
					var size int32
					if err := binary.Read(c, binary.LittleEndian, &size); err != nil {
						return
					}
					buf := make([]byte, size)
					if _, err := io.ReadFull(c, buf); err != nil {
						return
					}
					id := int32(binary.LittleEndian.Uint32(buf[0:4]))
					typ := int32(binary.LittleEndian.Uint32(buf[4:8]))
					body := string(buf[8 : len(buf)-2])
					write := func(id, typ int32, body string) {
						payload := make([]byte, 0, 10+len(body))
						payload = binary.LittleEndian.AppendUint32(payload, uint32(id))
						payload = binary.LittleEndian.AppendUint32(payload, uint32(typ))
						payload = append(payload, body...)
						payload = append(payload, 0, 0)
						_ = binary.Write(c, binary.LittleEndian, int32(len(payload)))
						c.Write(payload)
					}
					switch typ {
					case 3: // login
						if body == password {
							authed = true
							write(id, 2, "")
						} else {
							write(-1, 2, "")
						}
					case 2: // command
						if !authed {
							return
						}
						write(id, 0, "ok:"+body)
					}
				}
			}(conn)
		}
	}()
	return splitAddr(t, ln)
}

func varint(v int) []byte {
	var b []byte
	for {
		c := byte(v & 0x7f)
		v >>= 7
		if v != 0 {
			b = append(b, c|0x80)
		} else {
			return append(b, c)
		}
	}
}

func readVarint(r io.ByteReader) (int, error) {
	n, shift := 0, 0
	for {
		b, err := r.ReadByte()
		if err != nil {
			return 0, err
		}
		n |= int(b&0x7f) << shift
		if b&0x80 == 0 {
			return n, nil
		}
		shift += 7
	}
}

// fakeSLP answers the modern Server List Ping with a recorded response and
// answers the ping (what measures latency) with the same payload; pings
// counts the pings received.
func fakeSLP(t *testing.T, statusJSON string) (host string, port uint16, pings *atomic.Int32) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	pings = &atomic.Int32{}
	send := func(c net.Conn, id byte, data []byte) {
		body := append([]byte{id}, data...)
		c.Write(append(varint(len(body)), body...))
	}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				for {
					n, err := readVarint(&byteReader{c})
					if err != nil {
						return
					}
					pkt := make([]byte, n)
					if _, err := io.ReadFull(c, pkt); err != nil {
						return
					}
					switch pkt[0] {
					case 0x00:
						if len(pkt) == 1 { // status request
							s := []byte(statusJSON)
							send(c, 0x00, append(varint(len(s)), s...))
						} // otherwise, it is the handshake
					case 0x01: // ping
						pings.Add(1)
						send(c, 0x01, pkt[1:])
					}
				}
			}(c)
		}
	}()
	host, port = splitAddr(t, ln)
	return host, port, pings
}

type byteReader struct{ r io.Reader }

func (b *byteReader) ReadByte() (byte, error) {
	var x [1]byte
	_, err := io.ReadFull(b.r, x[:])
	return x[0], err
}

func TestRcon(t *testing.T) {
	host, port := fakeRcon(t, "secret")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := Rcon(ctx, host, port, "secret", "list")
	if err != nil {
		t.Fatal(err)
	}
	if out != "ok:list" {
		t.Fatalf("out = %q", out)
	}
	if _, err := Rcon(ctx, host, port, "wrong", "list"); err == nil {
		t.Fatal("a wrong password must fail")
	}
}

func TestRconContextCancelled(t *testing.T) {
	// server that accepts and never responds
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			t.Cleanup(func() { c.Close() })
		}
	}()
	host, port := splitAddr(t, ln)
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	start := time.Now()
	if _, err := Rcon(ctx, host, port, "x", "list"); err == nil {
		t.Fatal("expected an error")
	}
	if time.Since(start) > 3*time.Second {
		t.Fatal("Rcon does not respect the context")
	}
}

const paperStatus = `{"version":{"name":"Paper 1.21.4","protocol":769},"players":{"max":20,"online":3,"sample":[]},"description":{"text":"hello"}}`

func TestStatusOnline(t *testing.T) {
	host, port, _ := fakeSLP(t, paperStatus)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	st := Status(ctx, host, port)
	if !st.Online {
		t.Fatal("should be online")
	}
	if st.PlayersOnline != 3 || st.PlayersMax != 20 || st.Version != "Paper 1.21.4" {
		t.Fatalf("status = %v", st)
	}
}

func TestStatusOffline(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	start := time.Now()
	st := Status(ctx, "127.0.0.1", 1) // nobody listening
	if st.Online {
		t.Fatal("should be offline")
	}
	if time.Since(start) > 4*time.Second {
		t.Fatal("the ping must not take longer than its timeout")
	}
}

func TestStatusLatencyFromPing(t *testing.T) {
	// locally (as on the Docker network) the ping RTT is tens of µs:
	// the latency comes from the ping/pong and, even if sub-millisecond, it is not 0
	host, port, pings := fakeSLP(t, paperStatus)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	st := Status(ctx, host, port)
	if !st.Online {
		t.Fatal("should be online")
	}
	if pings.Load() == 0 {
		t.Fatal("the status ping must send the ping (Ping: true) to measure latency")
	}
	if st.LatencyMs == 0 {
		t.Fatalf("status = %v; a measured latency must not be reported as 0", st)
	}
}

func TestLatencyMsRoundsUp(t *testing.T) {
	for _, tc := range []struct {
		d    time.Duration
		want uint32
	}{
		{0, 0},
		{20 * time.Microsecond, 1},
		{time.Millisecond, 1},
		{time.Millisecond + time.Nanosecond, 2},
		{25300 * time.Microsecond, 26},
	} {
		if got := latencyMs(tc.d); got != tc.want {
			t.Errorf("latencyMs(%v) = %d, want %d", tc.d, got, tc.want)
		}
	}
}
