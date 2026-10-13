package app

import "encoding/json"

// logSecrets are the secrets of a server's spec that must not appear in its console (L2 of Plan 3). They are read
// without validating the spec: a spec that no longer validates must still hide them.
func (a *App) logSecrets(serverID string) []string {
	sp, err := a.st.GetSpec(serverID)
	if err != nil || sp == nil {
		return nil
	}
	var s struct {
		Rcon       string `json:"rconPassword"`
		CurseForge string `json:"curseforgeApiKey"`
	}
	if json.Unmarshal(sp.SpecJson, &s) != nil {
		return nil
	}
	return []string{s.Rcon, s.CurseForge}
}
