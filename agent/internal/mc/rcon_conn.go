package mc

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strconv"
	"time"
)

// Packet types of the Source RCON protocol.
const (
	typeCommandResp = 0
	typeCommand     = 2
	typeAuthResp    = 2
	typeAuth        = 3
)

// RconConn is an authenticated RCON session that supports several commands in a row over
// the same TCP connection. It serves periodic probes (TPS) without opening a connection
// per command: each new connection writes "Thread RCON Client … started/shutting
// down" to the server console.
//
// It is not safe for concurrent use. After any error it is closed and another
// must be opened with DialRcon.
type RconConn struct {
	conn   net.Conn
	nextID int32
	closed bool
}

// DialRcon opens an RCON connection and authenticates.
func DialRcon(ctx context.Context, host string, port uint16, password string) (*RconConn, error) {
	d := net.Dialer{Timeout: rconTimeout}
	conn, err := d.DialContext(ctx, "tcp", net.JoinHostPort(host, strconv.Itoa(int(port))))
	if err != nil {
		return nil, fmt.Errorf("rcon: connect: %w", err)
	}
	c := &RconConn{conn: conn, nextID: 1}
	if err := c.login(ctx, password); err != nil {
		c.Close()
		return nil, err
	}
	return c, nil
}

// rconDeadline is the deadline of an operation: the caller's ctx deadline if it
// has one (even if greater than rconTimeout: Plan 4 does long `save-all flush`);
// rconTimeout is only the default when ctx has no deadline.
func rconDeadline(ctx context.Context, now time.Time) time.Time {
	if dl, ok := ctx.Deadline(); ok {
		return dl
	}
	return now.Add(rconTimeout)
}

// arm sets the deadline of an operation and closes the connection if ctx is cancelled in the
// meantime. It returns the function that disarms that cancellation.
func (c *RconConn) arm(ctx context.Context) func() bool {
	_ = c.conn.SetDeadline(rconDeadline(ctx, time.Now()))
	return context.AfterFunc(ctx, func() { _ = c.conn.Close() })
}

func (c *RconConn) next() int32 {
	id := c.nextID
	c.nextID++
	if c.nextID <= 0 { // -1 means "wrong password": we never use it as an id
		c.nextID = 1
	}
	return id
}

func (c *RconConn) login(ctx context.Context, password string) error {
	stop := c.arm(ctx)
	defer stop()
	if err := writePacket(c.conn, c.next(), typeAuth, password); err != nil {
		return fmt.Errorf("rcon: login: %w", err)
	}
	for { // the server may first send an empty response packet
		id, typ, _, err := readPacket(c.conn)
		if err != nil {
			return fmt.Errorf("rcon: login: %w", err)
		}
		if typ != typeAuthResp {
			continue
		}
		if id == -1 {
			return errors.New("rcon: login: wrong password")
		}
		return nil
	}
}

// Command runs a command and returns its output. If it fails, the session is left closed.
func (c *RconConn) Command(ctx context.Context, command string) (string, error) {
	if c.closed {
		return "", errors.New("rcon: session closed")
	}
	stop := c.arm(ctx)
	defer stop()
	id := c.next()
	if err := writePacket(c.conn, id, typeCommand, command); err != nil {
		c.Close()
		return "", fmt.Errorf("rcon: execute: %w", err)
	}
	for {
		rid, typ, body, err := readPacket(c.conn)
		if err != nil {
			c.Close()
			return "", fmt.Errorf("rcon: execute: %w", err)
		}
		if typ == typeCommandResp && rid == id {
			return body, nil
		}
	}
}

// Close closes the connection. It is idempotent.
func (c *RconConn) Close() error {
	if c.closed {
		return nil
	}
	c.closed = true
	return c.conn.Close()
}
