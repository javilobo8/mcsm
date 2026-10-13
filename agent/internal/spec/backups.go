package spec

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/robfig/cron/v3"
)

// Backups is a server's backup schedule and retention (spec §4.1). If the spec
// does not carry it (nil) there are no scheduled backups and manual ones use DefaultBackupExcludes.
type Backups struct {
	Enabled            bool     `json:"enabled"`
	Cron               string   `json:"cron"`
	KeepDays           int      `json:"keepDays"`
	KeepCount          int      `json:"keepCount"`
	Excludes           []string `json:"excludes"`
	OnlyIfPlayersSince bool     `json:"onlyIfPlayersSince"`
}

// DefaultBackupExcludes does not include `*.jar`: .jar files uploaded by hand (mods, plugins) cannot
// be downloaded again, so by default they go into the backup.
var DefaultBackupExcludes = []string{"logs", "cache", "*.tmp"}

const (
	MaxBackupKeepDays  = 3650
	MaxBackupKeepCount = 1000
	MaxBackupExcludes  = 50
	maxCronLen         = 100
)

// excludeRe: relative patterns with letters, digits, `.`, `_`, `-`, `*`, `?` and `/` (not at the
// start). No brackets or backslashes: path.Match never gives ErrBadPattern and the
// panel validates exactly the same with zod.
var excludeRe = regexp.MustCompile(`^[A-Za-z0-9._*?-][A-Za-z0-9._*?/-]{0,199}$`)

var cronItemRe = regexp.MustCompile(`^(\*|\d{1,2}|\d{1,2}-\d{1,2})(/\d{1,2})?$`)

var cronFields = [5]struct {
	name     string
	min, max int
}{{"minute", 0, 59}, {"hour", 0, 23}, {"day of month", 1, 31}, {"month", 1, 12}, {"day of week", 0, 6}}

// ValidCron accepts the common 5-field syntax (minute hour day month day-of-week)
// with numbers, `*`, `,`, `-` and `/`. No names (MON, JAN), no `?`, no descriptors
// (@daily) or CRON_TZ: the panel validates the same (fixture proto/fixtures/cron-cases.json).
func ValidCron(expr string) error {
	if len(expr) > maxCronLen {
		return fmt.Errorf("cron expression too long")
	}
	// Printable ASCII, space and tab only: strings.Fields and JS's \s differ on
	// U+0085 and U+FEFF, so the panel and the agent share this strict rule.
	for _, r := range expr {
		if r != '\t' && (r < 0x20 || r > 0x7e) {
			return fmt.Errorf("invalid cron expression %q: only ASCII characters, spaces and tabs are supported", expr)
		}
	}
	fields := strings.Fields(expr)
	if len(fields) != 5 {
		return fmt.Errorf("invalid cron expression %q: must be 5 fields (minute hour day month day-of-week)", expr)
	}
	for i, f := range fields {
		lim := cronFields[i]
		for _, item := range strings.Split(f, ",") {
			m := cronItemRe.FindStringSubmatch(item)
			if m == nil {
				return fmt.Errorf("invalid cron expression %q: %s %q not valid", expr, lim.name, f)
			}
			if m[1] != "*" {
				lo, hi, isRange := strings.Cut(m[1], "-")
				if !isRange {
					hi = lo
				}
				l, _ := strconv.Atoi(lo)
				h, _ := strconv.Atoi(hi)
				if l < lim.min || h > lim.max || l > h {
					return fmt.Errorf("invalid cron expression %q: %s out of range (%d-%d)", expr, lim.name, lim.min, lim.max)
				}
			}
			if m[2] != "" {
				if step, _ := strconv.Atoi(m[2][1:]); step < 1 {
					return fmt.Errorf("invalid cron expression %q: the %s step must be at least 1", expr, lim.name)
				}
			}
		}
	}
	if _, err := cron.ParseStandard(expr); err != nil {
		return fmt.Errorf("invalid cron expression %q: %w", expr, err)
	}
	return nil
}

// Validate checks the backups section (nil is valid: no schedule).
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
		return fmt.Errorf("spec: backups.keepDays out of range (0-%d)", MaxBackupKeepDays)
	}
	if b.KeepCount < 0 || b.KeepCount > MaxBackupKeepCount {
		return fmt.Errorf("spec: backups.keepCount out of range (0-%d)", MaxBackupKeepCount)
	}
	if len(b.Excludes) > MaxBackupExcludes {
		return fmt.Errorf("spec: backups.excludes allows at most %d patterns", MaxBackupExcludes)
	}
	for _, p := range b.Excludes {
		if !excludeRe.MatchString(p) || strings.Contains(p, "..") {
			return fmt.Errorf("spec: backups.excludes: invalid pattern %q", p)
		}
	}
	return nil
}

// BackupExcludes returns the effective exclusions (a copy: the caller may modify it).
func (s Spec) BackupExcludes() []string {
	if s.Backups == nil {
		return append([]string(nil), DefaultBackupExcludes...)
	}
	return append([]string(nil), s.Backups.Excludes...)
}
