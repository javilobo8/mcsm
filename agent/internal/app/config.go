package app

import (
	"errors"
	"os"
)

// Config es la configuración del agente, leída del entorno.
type Config struct {
	PanelURL    string
	EnrollToken string
	NameHint    string
	DataRoot    string
	AgentData   string
	Network     string
	Version     string
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

// LoadConfig lee la configuración del entorno.
func LoadConfig(version string) (Config, error) {
	host, _ := os.Hostname()
	cfg := Config{
		PanelURL:    os.Getenv("PANEL_URL"),
		EnrollToken: os.Getenv("ENROLL_TOKEN"),
		NameHint:    getenv("NODE_NAME", host),
		DataRoot:    getenv("DATA_ROOT", "/srv/minecraft"),
		AgentData:   getenv("AGENT_DATA", "/var/lib/mcsm-agent"),
		Network:     getenv("MCSM_NETWORK", "mcsm"),
		Version:     version,
	}
	if cfg.PanelURL == "" {
		return cfg, errors.New("PANEL_URL es obligatoria")
	}
	return cfg, nil
}
