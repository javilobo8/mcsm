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

// defaultUploadMax is the default maximum size of a file upload (UPLOAD_MAX_BYTES).
const defaultUploadMax = 4 << 30

// routerNameRe validates MCSM_ROUTER_NAME (plan-8).
var routerNameRe = regexp.MustCompile(`^mcsm-[a-z0-9][a-z0-9-]{0,40}$`)

// Config is the agent's configuration, read from the environment.
type Config struct {
	PanelURL    string
	EnrollToken string
	NameHint    string
	DataRoot    string
	AgentData   string
	Network     string
	// RouterName is the name of the node's mc-router container (plan-8). MCSM_ROUTER_NAME only
	// for tests with real Docker (mcsm-test-…).
	RouterName string
	Version    string
	// UploadMax is the hard cap on a file upload, with or without an announced size.
	UploadMax int64
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

// LoadConfig reads the configuration from the environment.
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
		return cfg, errors.New("PANEL_URL is required")
	}
	u, err := url.Parse(cfg.PanelURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return cfg, fmt.Errorf("PANEL_URL must be an http:// or https:// URL (got %q)", cfg.PanelURL)
	}
	if !filepath.IsAbs(cfg.DataRoot) {
		return cfg, fmt.Errorf("DATA_ROOT must be an absolute path (got %q)", cfg.DataRoot)
	}
	if !routerNameRe.MatchString(cfg.RouterName) {
		return cfg, fmt.Errorf("MCSM_ROUTER_NAME must start with mcsm- and use only lowercase letters, digits and dashes (got %q)", cfg.RouterName)
	}
	if v := os.Getenv("UPLOAD_MAX_BYTES"); v != "" {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil || n <= 0 {
			return cfg, fmt.Errorf("UPLOAD_MAX_BYTES must be a number of bytes greater than 0 (got %q)", v)
		}
		cfg.UploadMax = n
	}
	return cfg, nil
}
