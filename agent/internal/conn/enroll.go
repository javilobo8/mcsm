// Package conn gestiona la comunicación saliente del agente con el panel.
package conn

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type EnrollResult struct {
	NodeID    string `json:"nodeId"`
	NodeToken string `json:"nodeToken"`
}

// Enroll canjea un token de alta de un solo uso por credenciales permanentes.
func Enroll(ctx context.Context, panelURL, enrollToken, nameHint, agentVersion string) (*EnrollResult, error) {
	body, _ := json.Marshal(map[string]string{"enrollToken": enrollToken, "nameHint": nameHint, "agentVersion": agentVersion})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(panelURL, "/")+"/agent/enroll", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := (&http.Client{Timeout: 15 * time.Second}).Do(req)
	if err != nil {
		return nil, fmt.Errorf("enroll: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return nil, fmt.Errorf("enroll: el panel respondió %d: %s", resp.StatusCode, strings.TrimSpace(string(msg)))
	}
	var out EnrollResult
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("enroll: respuesta inválida: %w", err)
	}
	if out.NodeID == "" || out.NodeToken == "" {
		return nil, fmt.Errorf("enroll: respuesta incompleta")
	}
	return &out, nil
}
