package spec

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/robfig/cron/v3"
)

// Backups es la programación y retención de copias de un servidor (spec §4.1). Si la spec
// no la trae (nil) no hay copias programadas y las manuales usan DefaultBackupExcludes.
type Backups struct {
	Enabled            bool     `json:"enabled"`
	Cron               string   `json:"cron"`
	KeepDays           int      `json:"keepDays"`
	KeepCount          int      `json:"keepCount"`
	Excludes           []string `json:"excludes"`
	OnlyIfPlayersSince bool     `json:"onlyIfPlayersSince"`
}

// DefaultBackupExcludes no incluye `*.jar`: los .jar subidos a mano (mods, plugins) no se
// pueden volver a descargar, así que por defecto entran en la copia.
var DefaultBackupExcludes = []string{"logs", "cache", "*.tmp"}

const (
	MaxBackupKeepDays  = 3650
	MaxBackupKeepCount = 1000
	MaxBackupExcludes  = 50
	maxCronLen         = 100
)

// excludeRe: patrones relativos con letras, dígitos, `.`, `_`, `-`, `*`, `?` y `/` (no al
// principio). Sin corchetes ni barras invertidas: path.Match nunca da ErrBadPattern y el
// panel valida exactamente lo mismo con zod.
var excludeRe = regexp.MustCompile(`^[A-Za-z0-9._*?-][A-Za-z0-9._*?/-]{0,199}$`)

var cronItemRe = regexp.MustCompile(`^(\*|\d{1,2}|\d{1,2}-\d{1,2})(/\d{1,2})?$`)

var cronFields = [5]struct {
	name     string
	min, max int
}{{"minuto", 0, 59}, {"hora", 0, 23}, {"día del mes", 1, 31}, {"mes", 1, 12}, {"día de la semana", 0, 6}}

// ValidCron acepta la sintaxis común de 5 campos (minuto hora día mes día-de-la-semana)
// con números, `*`, `,`, `-` y `/`. Sin nombres (MON, JAN), sin `?`, sin descriptores
// (@daily) ni CRON_TZ: el panel valida lo mismo (fixture proto/fixtures/cron-cases.json).
func ValidCron(expr string) error {
	if len(expr) > maxCronLen {
		return fmt.Errorf("expresión cron demasiado larga")
	}
	// Solo ASCII imprimible, espacio y tabulador: strings.Fields y el \s de JS difieren en
	// U+0085 y U+FEFF, así que el panel y el agente comparten esta regla estricta.
	for _, r := range expr {
		if r != '\t' && (r < 0x20 || r > 0x7e) {
			return fmt.Errorf("expresión cron inválida %q: solo se admiten caracteres ASCII, espacios y tabuladores", expr)
		}
	}
	fields := strings.Fields(expr)
	if len(fields) != 5 {
		return fmt.Errorf("expresión cron inválida %q: deben ser 5 campos (minuto hora día mes día-de-la-semana)", expr)
	}
	for i, f := range fields {
		lim := cronFields[i]
		for _, item := range strings.Split(f, ",") {
			m := cronItemRe.FindStringSubmatch(item)
			if m == nil {
				return fmt.Errorf("expresión cron inválida %q: %s %q no válido", expr, lim.name, f)
			}
			if m[1] != "*" {
				lo, hi, isRange := strings.Cut(m[1], "-")
				if !isRange {
					hi = lo
				}
				l, _ := strconv.Atoi(lo)
				h, _ := strconv.Atoi(hi)
				if l < lim.min || h > lim.max || l > h {
					return fmt.Errorf("expresión cron inválida %q: %s fuera de rango (%d-%d)", expr, lim.name, lim.min, lim.max)
				}
			}
			if m[2] != "" {
				if step, _ := strconv.Atoi(m[2][1:]); step < 1 {
					return fmt.Errorf("expresión cron inválida %q: el paso de %s debe ser al menos 1", expr, lim.name)
				}
			}
		}
	}
	if _, err := cron.ParseStandard(expr); err != nil {
		return fmt.Errorf("expresión cron inválida %q: %w", expr, err)
	}
	return nil
}

// Validate comprueba la sección de copias (nil es válida: sin programación).
func (b *Backups) Validate() error {
	if b == nil {
		return nil
	}
	if b.Enabled || b.Cron != "" {
		if err := ValidCron(b.Cron); err != nil {
			return fmt.Errorf("spec: backups.cron: %w", err)
		}
	}
	if b.KeepDays < 0 || b.KeepDays > MaxBackupKeepDays {
		return fmt.Errorf("spec: backups.keepDays fuera de rango (0-%d)", MaxBackupKeepDays)
	}
	if b.KeepCount < 0 || b.KeepCount > MaxBackupKeepCount {
		return fmt.Errorf("spec: backups.keepCount fuera de rango (0-%d)", MaxBackupKeepCount)
	}
	if len(b.Excludes) > MaxBackupExcludes {
		return fmt.Errorf("spec: backups.excludes admite como mucho %d patrones", MaxBackupExcludes)
	}
	for _, p := range b.Excludes {
		if !excludeRe.MatchString(p) || strings.Contains(p, "..") {
			return fmt.Errorf("spec: backups.excludes: patrón inválido %q", p)
		}
	}
	return nil
}

// BackupExcludes devuelve las exclusiones efectivas (una copia: el llamante puede modificarla).
func (s Spec) BackupExcludes() []string {
	if s.Backups == nil {
		return append([]string(nil), DefaultBackupExcludes...)
	}
	return append([]string(nil), s.Backups.Excludes...)
}
