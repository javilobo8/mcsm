package app

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"

	"mcsm/agent/internal/router"
)

// defaultUploadMax es el tamaño máximo por defecto de una subida de archivo (UPLOAD_MAX_BYTES).
const defaultUploadMax = 4 << 30

// routerNameRe valida MCSM_ROUTER_NAME (plan-8).
var routerNameRe = regexp.MustCompile(`^mcsm-[a-z0-9][a-z0-9-]{0,40}$`)

// Config es la configuración del agente, leída del entorno.
type Config struct {
	PanelURL    string
	EnrollToken string
	NameHint    string
	DataRoot    string
	AgentData   string
	Network     string
	// RouterName es el nombre del contenedor del mc-router del nodo (plan-8). MCSM_ROUTER_NAME solo
	// para pruebas con Docker real (mcsm-test-…).
	RouterName string
	Version    string
	// UploadMax es el tope duro de una subida de archivo, con o sin tamaño anunciado.
	UploadMax int64
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
		RouterName:  getenv("MCSM_ROUTER_NAME", router.ContainerName),
		Version:     version,
		UploadMax:   defaultUploadMax,
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
	if !routerNameRe.MatchString(cfg.RouterName) {
		return cfg, fmt.Errorf("MCSM_ROUTER_NAME debe empezar por mcsm- y usar solo minúsculas, números y guiones (recibido %q)", cfg.RouterName)
	}
	if v := os.Getenv("UPLOAD_MAX_BYTES"); v != "" {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil || n <= 0 {
			return cfg, fmt.Errorf("UPLOAD_MAX_BYTES debe ser un número de bytes mayor que 0 (recibido %q)", v)
		}
		cfg.UploadMax = n
	}
	return cfg, nil
}
