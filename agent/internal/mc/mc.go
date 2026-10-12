// Package mc habla con el servidor de Minecraft: ping de estado y RCON.
package mc

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"time"

	"github.com/mcstatus-io/mcutil/v4/options"
	"github.com/mcstatus-io/mcutil/v4/status"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
)

const (
	statusTimeout = 3 * time.Second
	rconTimeout   = 5 * time.Second
)

type StatusFunc = func(ctx context.Context, host string, port uint16) *mcsmv1.McStatus

// Status hace un Server List Ping. Nunca devuelve error: un servidor que no
// responde se reporta como Online=false.
func Status(ctx context.Context, host string, port uint16) *mcsmv1.McStatus {
	ctx, cancel := context.WithTimeout(ctx, statusTimeout)
	defer cancel()
	st, err := status.Modern(ctx, host, port, options.StatusModern{
		// Las opciones pasadas sustituyen a los valores por defecto de la
		// librería: con ReceiveLimitBytes=0 la lectura devuelve EOF y con
		// ProtocolVersion=0 el handshake es incorrecto, así que van explícitos.
		Timeout:           statusTimeout,
		ProtocolVersion:   -1,
		ReceiveLimitBytes: 1 << 20,
		Ping:              true,
	})
	if err != nil || st == nil {
		return &mcsmv1.McStatus{Online: false}
	}
	out := &mcsmv1.McStatus{
		Online:    true,
		Version:   st.Version.Name.Clean,
		LatencyMs: latencyMs(st.Latency),
	}
	if st.Players.Online != nil && *st.Players.Online > 0 {
		out.PlayersOnline = uint32(*st.Players.Online)
	}
	if st.Players.Max != nil && *st.Players.Max > 0 {
		out.PlayersMax = uint32(*st.Players.Max)
	}
	return out
}

// latencyMs redondea hacia arriba a milisegundos enteros. En la red Docker
// local el RTT del ping SLP es de decenas de µs: truncar (Duration.Milliseconds)
// lo dejaría siempre en 0, indistinguible de "sin medir".
func latencyMs(d time.Duration) uint32 {
	if d <= 0 {
		return 0
	}
	return uint32((d + time.Millisecond - 1) / time.Millisecond)
}

// Rcon ejecuta un comando y devuelve la salida.
//
// Implementa el protocolo Source RCON directamente en lugar de usar
// mcutil/rcon: ese cliente (v4.3.1) tiene una data race entre Login y Close,
// imprime errores por stdout, deja NULs en la salida y no admite cancelación.
func Rcon(ctx context.Context, host string, port uint16, password, command string) (string, error) {
	d := net.Dialer{Timeout: rconTimeout}
	conn, err := d.DialContext(ctx, "tcp", net.JoinHostPort(host, strconv.Itoa(int(port))))
	if err != nil {
		return "", fmt.Errorf("rcon: conectar: %w", err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(rconDeadline(ctx, time.Now()))
	// Cancelación explícita: cerrar la conexión desbloquea las lecturas.
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()

	const (
		typeCommandResp = 0
		typeCommand     = 2
		typeAuthResp    = 2
		typeAuth        = 3
	)
	if err := writePacket(conn, 1, typeAuth, password); err != nil {
		return "", fmt.Errorf("rcon: login: %w", err)
	}
	for { // el servidor puede enviar antes un paquete de respuesta vacío
		id, typ, _, err := readPacket(conn)
		if err != nil {
			return "", fmt.Errorf("rcon: login: %w", err)
		}
		if typ != typeAuthResp {
			continue
		}
		if id == -1 {
			return "", errors.New("rcon: login: contraseña incorrecta")
		}
		break
	}
	if err := writePacket(conn, 2, typeCommand, command); err != nil {
		return "", fmt.Errorf("rcon: ejecutar: %w", err)
	}
	for {
		id, typ, body, err := readPacket(conn)
		if err != nil {
			return "", fmt.Errorf("rcon: ejecutar: %w", err)
		}
		if typ == typeCommandResp && id == 2 {
			return body, nil
		}
	}
}

// rconDeadline es el plazo del contexto si lo tiene (un save-all flush en un mundo grande
// tarda más de 5 s) o, si no, rconTimeout.
func rconDeadline(ctx context.Context, now time.Time) time.Time {
	if dl, ok := ctx.Deadline(); ok {
		return dl
	}
	return now.Add(rconTimeout)
}

func writePacket(w io.Writer, id, typ int32, body string) error {
	buf := make([]byte, 0, 14+len(body))
	buf = binary.LittleEndian.AppendUint32(buf, uint32(10+len(body)))
	buf = binary.LittleEndian.AppendUint32(buf, uint32(id))
	buf = binary.LittleEndian.AppendUint32(buf, uint32(typ))
	buf = append(buf, body...)
	buf = append(buf, 0, 0)
	_, err := w.Write(buf)
	return err
}

func readPacket(r io.Reader) (id, typ int32, body string, err error) {
	var size int32
	if err = binary.Read(r, binary.LittleEndian, &size); err != nil {
		return
	}
	if size < 10 || size > 8192 {
		err = fmt.Errorf("paquete con tamaño inválido: %d", size)
		return
	}
	buf := make([]byte, size)
	if _, err = io.ReadFull(r, buf); err != nil {
		return
	}
	id = int32(binary.LittleEndian.Uint32(buf[0:4]))
	typ = int32(binary.LittleEndian.Uint32(buf[4:8]))
	body = string(buf[8 : size-2])
	return
}
