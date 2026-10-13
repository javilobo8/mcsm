// Package mc talks to the Minecraft server: status ping and RCON.
package mc

import (
	"context"
	"encoding/binary"
	"fmt"
	"io"
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

// Status does a Server List Ping. It never returns an error: a server that does not
// respond is reported as Online=false.
func Status(ctx context.Context, host string, port uint16) *mcsmv1.McStatus {
	ctx, cancel := context.WithTimeout(ctx, statusTimeout)
	defer cancel()
	st, err := status.Modern(ctx, host, port, options.StatusModern{
		// The options passed replace the library's default values:
		// with ReceiveLimitBytes=0 the read returns EOF and with
		// ProtocolVersion=0 the handshake is wrong, so they are explicit.
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

// latencyMs rounds up to whole milliseconds. On the local Docker
// network the SLP ping RTT is tens of µs: truncating (Duration.Milliseconds)
// would always leave it at 0, indistinguishable from "not measured".
func latencyMs(d time.Duration) uint32 {
	if d <= 0 {
		return 0
	}
	return uint32((d + time.Millisecond - 1) / time.Millisecond)
}

// Rcon runs a command and returns the output.
//
// It implements the Source RCON protocol directly instead of using
// mcutil/rcon: that client (v4.3.1) has a data race between Login and Close,
// prints errors to stdout, leaves NULs in the output and does not support cancellation.
func Rcon(ctx context.Context, host string, port uint16, password, command string) (string, error) {
	c, err := DialRcon(ctx, host, port, password)
	if err != nil {
		return "", err
	}
	defer c.Close()
	return c.Command(ctx, command)
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
		err = fmt.Errorf("packet with invalid size: %d", size)
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
