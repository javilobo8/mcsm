package app

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
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
	u, err := url.Parse(cfg.PanelURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return cfg, fmt.Errorf("PANEL_URL debe ser una URL http:// o https:// (recibido %q)", cfg.PanelURL)
	}
	if !filepath.IsAbs(cfg.DataRoot) {
		return cfg, fmt.Errorf("DATA_ROOT debe ser una ruta absoluta (recibido %q)", cfg.DataRoot)
	}
	return cfg, nil
}
