package app

import (
	"errors"
	"fmt"
	"regexp"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/errcode"
	"mcsm/agent/internal/store"
)

// nodeTokenRe: the permanent token the panel generates (randomToken: 32 bytes in base64url, 43 characters).
var nodeTokenRe = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)

// handleRotateToken (spec §9) stores the new token BEFORE answering and, after the Ack, closes the session to
// reconnect with it. If the Ack is lost, the panel keeps the token as pending and accepts it on reconnection.
// Transfers read the token from the store on each one (App.transfers): they use the new one right away.
//
// They are served one at a time: the client dispatches each message in its goroutine and, mixed up, two rotations could
// leave one token in the store and the other in the client.
func (a *App) handleRotateToken(id uint64, req *mcsmv1.RotateToken, send func(*mcsmv1.Envelope) error) {
	a.rotateMu.Lock()
	defer a.rotateMu.Unlock()
	tok := req.GetToken()
	if !nodeTokenRe.MatchString(tok) {
		_ = send(errMsg(id, errcode.InvalidRequest, errors.New("node token with an invalid format")))
		return
	}
	creds, err := a.st.Credentials()
	if err == nil && creds == nil {
		err = errors.New("the node has no stored credentials")
	}
	if err != nil {
		_ = send(errMsg(id, errcode.IOError, fmt.Errorf("read the node's credentials: %w", err)))
		return
	}
	if err := a.st.SaveCredentials(store.Credentials{NodeID: creds.NodeID, Token: tok}); err != nil {
		_ = send(errMsg(id, errcode.IOError, fmt.Errorf("save the new token: %w", err)))
		return
	}
	a.setToken(tok)
	_ = send(ack(id))
	a.log.Info("node token rotated: reconnecting with the new one")
	a.reconnect()
}
