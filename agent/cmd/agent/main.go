package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"mcsm/agent/internal/app"
)

var version = "dev"

func main() {
	if len(os.Args) > 1 && (os.Args[1] == "-version" || os.Args[1] == "--version") {
		fmt.Println(version)
		return
	}
	log := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(log)
	cfg, err := app.LoadConfig(version)
	if err != nil {
		log.Error("configuración inválida", "err", err)
		os.Exit(2)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	log.Info("mcsm-agent arrancando", "version", version, "panel", cfg.PanelURL, "data_root", cfg.DataRoot)
	if err := app.Run(ctx, cfg, log); err != nil {
		log.Error("el agente terminó con error", "err", err)
		os.Exit(1)
	}
}
