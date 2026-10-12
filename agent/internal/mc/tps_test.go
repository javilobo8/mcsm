package mc

import "testing"

func TestParseTPS(t *testing.T) {
	cases := []struct {
		name string
		out  string
		want float64
		ok   bool
	}{
		{"paper", "§6TPS from last 1m, 5m, 15m: §a20.0, §a20.0, §a20.0", 20, true},
		{"paper recortado", "§6TPS from last 1m, 5m, 15m: §a*20.0, §a19.5, §a19.9", 20, true},
		{"paper con lag", "§6TPS from last 1m, 5m, 15m: §e17.12, §a19.50, §a19.90", 17.12, true},
		{"purpur con 5s", "§6TPS from last 5s, 1m, 5m, 15m: §a19.8, §a18.5, §a20.0, §a20.0", 18.5, true},
		{"sin colores y con más líneas", "TPS from last 1m, 5m, 15m: 20.0, 20.0, 20.0\nCurrent Memory Usage: 1024/4096 mb", 20, true},
		{"color hex de Adventure", "§x§f§f§a§a§0§0TPS from last 1m, 5m, 15m: §x§5§5§f§f§5§519.9, 20.0, 20.0", 19.9, true},
		{"comando desconocido (vanilla)", "Unknown or incomplete command, see below for error", 0, false},
		{"vacío", "", 0, false},
		{"valores ausentes", "TPS from last 1m, 5m, 15m:", 0, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, ok := ParseTPS(c.out)
			if ok != c.ok || got != c.want {
				t.Fatalf("ParseTPS(%q) = %v, %v; want %v, %v", c.out, got, ok, c.want, c.ok)
			}
		})
	}
}
