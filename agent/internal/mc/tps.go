package mc

import (
	"math"
	"regexp"
	"strconv"
	"strings"
)

var (
	// colorCode are the legacy formatting codes (§a, §l, §x…) that Paper leaves in the
	// output of commands over RCON.
	colorCode = regexp.MustCompile(`§[0-9a-fk-orxA-FK-ORX]`)
	tpsLine   = regexp.MustCompile(`(?i)TPS from last ([^:\n]+):([^\n]*)`)
	number    = regexp.MustCompile(`^\*?\s*([0-9]+(?:\.[0-9]+)?)`)
)

// ParseTPS extracts the last-minute TPS from the output of Paper's `tps` command
// ("TPS from last 1m, 5m, 15m: 20.0, 20.0, 20.0") or Purpur's (adds "5s" in front).
// It accepts § color codes and the * prefix with which Paper marks capped values.
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
