package mc

import (
	"context"
	"encoding/binary"
	"io"
	"net"
	"strconv"
	"testing"
	"time"
)

func splitAddr(t *testing.T, ln net.Listener) (string, uint16) {
	t.Helper()
	_, p, _ := net.SplitHostPort(ln.Addr().String())
	n, _ := strconv.Atoi(p)
	return "127.0.0.1", uint16(n)
}

// fakeRcon implementa lo justo del protocolo Source RCON:
// paquete = int32 longitud, int32 id, int32 tipo, cuerpo\0, \0
func fakeRcon(t *testing.T, password string) (host string, port uint16) {
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

// fakeSLP responde al Server List Ping moderno con una respuesta grabada.
func fakeSLP(t *testing.T, statusJSON string) (host string, port uint16) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
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
						} // si no, es el handshake
					case 0x01: // ping
						send(c, 0x01, pkt[1:])
					}
				}
			}(c)
		}
	}()
	return splitAddr(t, ln)
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
		t.Fatal("contraseña incorrecta debe fallar")
	}
}

func TestRconContextCancelled(t *testing.T) {
	// servidor que acepta y nunca responde
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
		t.Fatal("esperaba error")
	}
	if time.Since(start) > 3*time.Second {
		t.Fatal("Rcon no respeta el contexto")
	}
}

func TestStatusOnline(t *testing.T) {
	host, port := fakeSLP(t, `{"version":{"name":"Paper 1.21.4","protocol":769},"players":{"max":20,"online":3,"sample":[]},"description":{"text":"hola"}}`)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	st := Status(ctx, host, port)
	if !st.Online {
		t.Fatal("debería estar online")
	}
	if st.PlayersOnline != 3 || st.PlayersMax != 20 || st.Version != "Paper 1.21.4" {
		t.Fatalf("status = %v", st)
	}
}

func TestStatusOffline(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	start := time.Now()
	st := Status(ctx, "127.0.0.1", 1) // nadie escucha
	if st.Online {
		t.Fatal("debería estar offline")
	}
	if time.Since(start) > 4*time.Second {
		t.Fatal("el ping no debe tardar más que su timeout")
	}
}
