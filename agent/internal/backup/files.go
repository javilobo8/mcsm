package backup

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/spec"
)

const (
	// Ext is the backups' extension.
	Ext = ".tar.zst"
	// MetaExt is the extension of the metadata file that accompanies each backup.
	MetaExt    = ".json"
	partialExt = ".partial"
	// tsLayout is basic ISO 8601 in UTC with milliseconds (without `:`: portable name).
	tsLayout        = "20060102T150405.000Z"
	preRestoreInfix = ".pre-restore-"
	restoringInfix  = ".restoring-"

	TriggerManual       = "manual"
	TriggerScheduled    = "scheduled"
	TriggerPreMigration = "pre_migration"
	TriggerPreRestore   = "pre_restore"
)

var (
	nameTailRe = regexp.MustCompile(`^(\d{8}T\d{6}\.\d{3}Z)-(\d{1,19})\.tar\.zst$`)
	tsRe       = regexp.MustCompile(`^\d{8}T\d{6}\.\d{3}Z$`)
)

// Meta is a backup's metadata: the .json next to the .tar.zst (and next to each
// pre-restore directory).
type Meta struct {
	Filename    string    `json:"filename"`
	ServerID    string    `json:"serverId"`
	Slug        string    `json:"slug"`
	SpecVersion uint64    `json:"specVersion"`
	Trigger     string    `json:"trigger"` // manual | scheduled | pre_migration | pre_restore
	SizeBytes   int64     `json:"sizeBytes"`
	SHA256      string    `json:"sha256"`
	StartedAt   time.Time `json:"startedAt"`
	FinishedAt  time.Time `json:"finishedAt"`
	Excludes    []string  `json:"excludes,omitempty"`
	Files       int       `json:"files,omitempty"`
	DataBytes   int64     `json:"dataBytes,omitempty"` // uncompressed content: what it will take when restored
}

// Dir is a server's backups directory: <dataRoot>/<slug>/backups.
func Dir(dataRoot, slug string) string { return filepath.Join(dataRoot, slug, "backups") }

// Filename es <slug>-<YYYYMMDDTHHMMSS.mmmZ>-<spec_version>.tar.zst (spec §6.5).
func Filename(slug string, t time.Time, specVersion uint64) string {
	return fmt.Sprintf("%s-%s-%d%s", slug, t.UTC().Format(tsLayout), specVersion, Ext)
}

// ValidName reports whether name is a .tar.zst backup of that slug. A valid name never
// contains `/` or `..`.
func ValidName(slug, name string) bool {
	rest, ok := strings.CutPrefix(name, slug+"-")
	return ok && spec.ValidSlug(slug) && nameTailRe.MatchString(rest)
}

// PreRestoreName is the name of the directory where the data prior to a restore is
// kept, next to dataDir: e.g. data.pre-restore-20261012T040000.000Z.
func PreRestoreName(dataDir string, t time.Time) string {
	return filepath.Base(dataDir) + preRestoreInfix + t.UTC().Format(tsLayout)
}

// ValidPreRestoreName reports whether name is a pre-restore directory of dataDir.
func ValidPreRestoreName(dataDir, name string) bool {
	rest, ok := strings.CutPrefix(name, filepath.Base(dataDir)+preRestoreInfix)
	return ok && tsRe.MatchString(rest)
}

func parseName(slug, name string) (time.Time, uint64, bool) {
	rest, ok := strings.CutPrefix(name, slug+"-")
	if !ok {
		return time.Time{}, 0, false
	}
	m := nameTailRe.FindStringSubmatch(rest)
	if m == nil {
		return time.Time{}, 0, false
	}
	ts, err := time.Parse(tsLayout, m[1])
	if err != nil {
		return time.Time{}, 0, false
	}
	v, err := strconv.ParseUint(m[2], 10, 64)
	if err != nil {
		return time.Time{}, 0, false
	}
	return ts, v, true
}

// WriteMeta writes <dir>/<m.Filename>.json atomically.
func WriteMeta(dir string, m Meta) error {
	return writeJSON(filepath.Join(dir, m.Filename+MetaExt), m)
}

// writeJSON writes p atomically and durably: temporary file, fsync and rename (the
// caller syncs the directory).
func writeJSON(p string, v any) (err error) {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	tmp := p + partialExt
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o640)
	if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			_ = os.Remove(tmp)
		}
	}()
	if _, err = f.Write(b); err == nil {
		err = f.Sync()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

// ReadMeta lee <dir>/<name>.json.
func ReadMeta(dir, name string) (Meta, error) {
	b, err := os.ReadFile(filepath.Join(dir, name+MetaExt))
	if err != nil {
		return Meta{}, err
	}
	var m Meta
	if err := json.Unmarshal(b, &m); err != nil {
		return Meta{}, fmt.Errorf("unreadable metadata of %s: %w", name, err)
	}
	m.Filename = name
	return m, nil
}

// List returns a server's .tar.zst backups, most recent first. A backup
// without a .json (or with an unreadable one) is listed with what is deduced from the name. It ignores
// .partial files (backups in progress or aborted). A nonexistent directory is an empty list.
func List(backupsDir, slug string) ([]Meta, error) {
	ents, err := os.ReadDir(backupsDir)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []Meta
	for _, e := range ents {
		name := e.Name()
		if !e.Type().IsRegular() || !ValidName(slug, name) {
			continue
		}
		m, err := ReadMeta(backupsDir, name)
		if err != nil {
			ts, ver, _ := parseName(slug, name)
			m = Meta{Filename: name, Slug: slug, SpecVersion: ver, Trigger: TriggerManual, StartedAt: ts, FinishedAt: ts}
		}
		if info, err := e.Info(); err == nil {
			m.SizeBytes = info.Size()
		}
		out = append(out, m)
	}
	sortNewest(out)
	return out, nil
}

// ListPreRestore returns the pre-restore directories next to dataDir.
func ListPreRestore(dataDir string) ([]Meta, error) {
	parent := filepath.Dir(dataDir)
	ents, err := os.ReadDir(parent)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []Meta
	for _, e := range ents {
		name := e.Name()
		if !e.IsDir() || !ValidPreRestoreName(dataDir, name) {
			continue
		}
		m, err := ReadMeta(parent, name)
		if err != nil {
			ts, _ := time.Parse(tsLayout, strings.TrimPrefix(name, filepath.Base(dataDir)+preRestoreInfix))
			m = Meta{StartedAt: ts, FinishedAt: ts}
		}
		m.Filename, m.Trigger = name, TriggerPreRestore
		out = append(out, m)
	}
	sortNewest(out)
	return out, nil
}

// Delete deletes a backup (.tar.zst and its .json) or a pre-restore directory of dataDir.
// The name is validated before touching anything; that it no longer exists is not an error.
func Delete(backupsDir, dataDir, slug, name string) error {
	switch {
	case ValidName(slug, name):
		return removeIn(backupsDir, name, false)
	case ValidPreRestoreName(dataDir, name):
		return removeIn(filepath.Dir(dataDir), name, true)
	default:
		return fmt.Errorf("invalid backup name %q", name)
	}
}

// removeIn deletes name (and its .json) inside dir without being able to leave it (os.Root).
func removeIn(dir, name string, recursive bool) error {
	root, err := os.OpenRoot(dir)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer root.Close()
	if recursive {
		err = root.RemoveAll(name)
	} else {
		err = root.Remove(name)
	}
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	if err := root.Remove(name + MetaExt); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

// PrunePlan returns the backups to delete according to the retention. Only scheduled ones
// count (manual, pre_migration and pre_restore ones are deleted by hand); the most recent one is never
// deleted; 0 = no limit.
func PrunePlan(metas []Meta, keepDays, keepCount int, now time.Time) []string {
	var sched []Meta
	for _, m := range metas {
		if m.Trigger == TriggerScheduled {
			sched = append(sched, m)
		}
	}
	sortNewest(sched)
	var out []string
	for i, m := range sched {
		if i == 0 {
			continue
		}
		tooMany := keepCount > 0 && i >= keepCount
		tooOld := keepDays > 0 && now.Sub(m.StartedAt) > time.Duration(keepDays)*24*time.Hour
		if tooMany || tooOld {
			out = append(out, m.Filename)
		}
	}
	return out
}

func sortNewest(ms []Meta) {
	sort.SliceStable(ms, func(i, j int) bool {
		if !ms[i].StartedAt.Equal(ms[j].StartedAt) {
			return ms[i].StartedAt.After(ms[j].StartedAt)
		}
		return ms[i].Filename > ms[j].Filename
	})
}

// Info converts the metadata to the protocol message.
func (m Meta) Info(serverID string) *mcsmv1.BackupInfo {
	info := &mcsmv1.BackupInfo{
		ServerId: serverID, Filename: m.Filename, Sha256: m.SHA256, SpecVersion: m.SpecVersion,
		Trigger: TriggerToProto(m.Trigger),
	}
	if m.SizeBytes > 0 {
		info.SizeBytes = uint64(m.SizeBytes)
	}
	if !m.StartedAt.IsZero() {
		info.StartedUnixMs = m.StartedAt.UnixMilli()
	}
	if !m.FinishedAt.IsZero() {
		info.FinishedUnixMs = m.FinishedAt.UnixMilli()
	}
	return info
}

// TriggerToProto converts the .json's trigger to the protocol enum.
func TriggerToProto(t string) mcsmv1.BackupTrigger {
	switch t {
	case TriggerScheduled:
		return mcsmv1.BackupTrigger_BACKUP_TRIGGER_SCHEDULED
	case TriggerPreMigration:
		return mcsmv1.BackupTrigger_BACKUP_TRIGGER_PRE_MIGRATION
	case TriggerPreRestore:
		return mcsmv1.BackupTrigger_BACKUP_TRIGGER_PRE_RESTORE
	default:
		return mcsmv1.BackupTrigger_BACKUP_TRIGGER_MANUAL
	}
}

// TriggerFromProto is the inverse; UNSPECIFIED counts as manual.
func TriggerFromProto(t mcsmv1.BackupTrigger) string {
	switch t {
	case mcsmv1.BackupTrigger_BACKUP_TRIGGER_SCHEDULED:
		return TriggerScheduled
	case mcsmv1.BackupTrigger_BACKUP_TRIGGER_PRE_MIGRATION:
		return TriggerPreMigration
	case mcsmv1.BackupTrigger_BACKUP_TRIGGER_PRE_RESTORE:
		return TriggerPreRestore
	default:
		return TriggerManual
	}
}
