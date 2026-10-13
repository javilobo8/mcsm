package app

import (
	"errors"
	"fmt"
	"regexp"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/errcode"
	"mcsm/agent/internal/store"
)

// nodeTokenRe: el token permanente que genera el panel (randomToken: 32 bytes en base64url, 43 caracteres).
var nodeTokenRe = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)

// handleRotateToken (spec §9) guarda el token nuevo ANTES de responder y, tras el Ack, cierra la sesión para
// reconectar con él. Si el Ack se pierde, el panel conserva el token como pendiente y lo acepta en la reconexión.
// Las transferencias leen el token del store en cada una (App.transfers): usan el nuevo desde ya.
//
// Se atienden de uno en uno: el cliente despacha cada mensaje en su goroutine y, mezcladas, dos rotaciones podrían
// dejar en el store un token y en el cliente el otro.
func (a *App) handleRotateToken(id uint64, req *mcsmv1.RotateToken, send func(*mcsmv1.Envelope) error) {
	a.rotateMu.Lock()
	defer a.rotateMu.Unlock()
	tok := req.GetToken()
	if !nodeTokenRe.MatchString(tok) {
		_ = send(errMsg(id, errcode.InvalidRequest, errors.New("token de nodo con formato inválido")))
		return
	}
	creds, err := a.st.Credentials()
	if err == nil && creds == nil {
		err = errors.New("el nodo no tiene credenciales guardadas")
	}
	if err != nil {
		_ = send(errMsg(id, errcode.IOError, fmt.Errorf("leer las credenciales del nodo: %w", err)))
		return
	}
	if err := a.st.SaveCredentials(store.Credentials{NodeID: creds.NodeID, Token: tok}); err != nil {
		_ = send(errMsg(id, errcode.IOError, fmt.Errorf("guardar el token nuevo: %w", err)))
		return
	}
	a.setToken(tok)
	_ = send(ack(id))
	a.log.Info("token del nodo rotado: se reconecta con el nuevo")
	a.reconnect()
}
