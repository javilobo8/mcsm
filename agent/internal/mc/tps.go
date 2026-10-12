package mc

import (
	"math"
	"regexp"
	"strconv"
	"strings"
)

var (
	// colorCode son los códigos de formato heredados (§a, §l, §x…) que Paper deja en la
	// salida de los comandos por RCON.
	colorCode = regexp.MustCompile(`§[0-9a-fk-orxA-FK-ORX]`)
	tpsLine   = regexp.MustCompile(`(?i)TPS from last ([^:\n]+):([^\n]*)`)
	number    = regexp.MustCompile(`^\*?\s*([0-9]+(?:\.[0-9]+)?)`)
)

// ParseTPS extrae el TPS del último minuto de la salida del comando `tps` de Paper
// ("TPS from last 1m, 5m, 15m: 20.0, 20.0, 20.0") o Purpur (añade "5s" delante).
// Admite códigos de color § y el prefijo * con el que Paper marca valores recortados.
func ParseTPS(out string) (float64, bool) {
	m := tpsLine.FindStringSubmatch(colorCode.ReplaceAllString(out, ""))
	if m == nil {
		return 0, false
	}
	labels := strings.Split(m[1], ",")
	values := strings.Split(m[2], ",")
	idx := 0
	for i, l := range labels {
		if strings.TrimSpace(l) == "1m" {
			idx = i
			break
		}
	}
	if idx >= len(values) {
		return 0, false
	}
	n := number.FindStringSubmatch(strings.TrimSpace(values[idx]))
	if n == nil {
		return 0, false
	}
	v, err := strconv.ParseFloat(n[1], 64)
	if err != nil || math.IsNaN(v) || math.IsInf(v, 0) {
		return 0, false
	}
	return v, true
}
