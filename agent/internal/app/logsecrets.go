package app

import "encoding/json"

// logSecrets son los secretos de la spec de un servidor que no deben salir en su consola (L2 del Plan 3). Se leen
// sin validar la spec: una spec que ya no valida sigue teniendo que ocultarlos.
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
