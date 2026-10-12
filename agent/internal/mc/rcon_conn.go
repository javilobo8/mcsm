package mc

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strconv"
	"time"
)

// Tipos de paquete del protocolo Source RCON.
const (
	typeCommandResp = 0
	typeCommand     = 2
	typeAuthResp    = 2
	typeAuth        = 3
)

// RconConn es una sesión RCON autenticada que admite varios comandos seguidos sobre
// la misma conexión TCP. Sirve para sondeos periódicos (TPS) sin abrir una conexión
// por comando: cada conexión nueva escribe "Thread RCON Client … started/shutting
// down" en la consola del servidor.
//
// No es segura para uso concurrente. Tras cualquier error queda cerrada y hay que
// abrir otra con DialRcon.
type RconConn struct {
	conn   net.Conn
	nextID int32
	closed bool
}

// DialRcon abre una conexión RCON y se autentica.
func DialRcon(ctx context.Context, host string, port uint16, password string) (*RconConn, error) {
	d := net.Dialer{Timeout: rconTimeout}
	conn, err := d.DialContext(ctx, "tcp", net.JoinHostPort(host, strconv.Itoa(int(port))))
	if err != nil {
		return nil, fmt.Errorf("rcon: conectar: %w", err)
	}
	c := &RconConn{conn: conn, nextID: 1}
	if err := c.login(ctx, password); err != nil {
		c.Close()
		return nil, err
	}
	return c, nil
}

// rconDeadline es el plazo de una operación: el deadline del ctx del llamador si lo
// tiene (aunque sea mayor que rconTimeout: el Plan 4 hace `save-all flush` largos);
// rconTimeout solo es el valor por defecto cuando el ctx no tiene deadline.
func rconDeadline(ctx context.Context, now time.Time) time.Time {
	if dl, ok := ctx.Deadline(); ok {
		return dl
	}
	return now.Add(rconTimeout)
}

// arm fija el plazo de una operación y cierra la conexión si ctx se cancela mientras
// tanto. Devuelve la función que desarma esa cancelación.
func (c *RconConn) arm(ctx context.Context) func() bool {
	_ = c.conn.SetDeadline(rconDeadline(ctx, time.Now()))
	return context.AfterFunc(ctx, func() { _ = c.conn.Close() })
}

func (c *RconConn) next() int32 {
	id := c.nextID
	c.nextID++
	if c.nextID <= 0 { // -1 significa "contraseña incorrecta": nunca lo usamos como id
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
	for { // el servidor puede enviar antes un paquete de respuesta vacío
		id, typ, _, err := readPacket(c.conn)
		if err != nil {
			return fmt.Errorf("rcon: login: %w", err)
		}
		if typ != typeAuthResp {
			continue
		}
		if id == -1 {
			return errors.New("rcon: login: contraseña incorrecta")
		}
		return nil
	}
}

// Command ejecuta un comando y devuelve su salida. Si falla, la sesión queda cerrada.
func (c *RconConn) Command(ctx context.Context, command string) (string, error) {
	if c.closed {
		return "", errors.New("rcon: sesión cerrada")
	}
	stop := c.arm(ctx)
	defer stop()
	id := c.next()
	if err := writePacket(c.conn, id, typeCommand, command); err != nil {
		c.Close()
		return "", fmt.Errorf("rcon: ejecutar: %w", err)
	}
	for {
		rid, typ, body, err := readPacket(c.conn)
		if err != nil {
			c.Close()
			return "", fmt.Errorf("rcon: ejecutar: %w", err)
		}
		if typ == typeCommandResp && rid == id {
			return body, nil
		}
	}
}

// Close cierra la conexión. Es idempotente.
func (c *RconConn) Close() error {
	if c.closed {
		return nil
	}
	c.closed = true
	return c.conn.Close()
}
