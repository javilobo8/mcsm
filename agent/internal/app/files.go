package app

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"sync"
	"sync/atomic"
	"time"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/conn"
	"mcsm/agent/internal/errcode"
	"mcsm/agent/internal/files"
	"mcsm/agent/internal/reconcile"
	"mcsm/agent/internal/spec"
)

const (
	// filesShutdownWait is the cap on the wait for the Files* in progress when the agent shuts down.
	filesShutdownWait = 20 * time.Second
	// orphanTempAge: at startup, upload temporaries untouched for longer than this are deleted.
	orphanTempAge = time.Hour
	// maxTransfers bounds the node's simultaneous uploads and downloads (descriptors, temporaries
	// and connections). The next one gets busy instantly, without consuming its transfer.
	maxTransfers = 4
	// transferIdle: a transfer that moves no byte during a whole period is cut off
	// (detected between 1 and 2 periods after the last byte).
	transferIdle = 60 * time.Second
)

var (
	errTransfersBusy = fmt.Errorf("the node already has %d file transfers in progress: wait for one to finish", maxTransfers)
	errIdle          = errors.New("idle transfer")
	errFilesClosing  = errors.New("the agent is shutting down: try again when it reconnects")
)

// transferGate counts the transfers in progress, carries the idle watchdog's clock and
// registers the Files* in progress so that the shutdown waits for them. The zero value is
// usable.
type transferGate struct {
	mu     sync.Mutex
	active int
	// after is the watchdog's clock (nil → time.After). Only tests change it.
	after func(time.Duration) <-chan time.Time
	// ops counts the Files* in progress; closed prevents others from starting once the shutdown has begun
	// (an Add with the counter at zero cannot race with a running Wait).
	ops    sync.WaitGroup
	closed bool
}

// enter registers a Files* that starts; false if the agent is already shutting down.
func (g *transferGate) enter() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.closed {
		return false
	}
	g.ops.Add(1)
	return true
}

func (g *transferGate) leave() { g.ops.Done() }

// wait closes the entry of new Files* and waits, for at most d, for those in progress to
// finish. On shutdown, the life context is already cancelled: transfers are cut and
// WriteFrom deletes its temporary; what this waits for is that cleanup (and a write or a deletion
// that are half done), so the process does not exit leaving orphaned temporaries. It returns
// false if the deadline expired.
func (g *transferGate) wait(d time.Duration) bool {
	g.mu.Lock()
	g.closed = true
	g.mu.Unlock()
	done := make(chan struct{})
	go func() {
		g.ops.Wait()
		close(done)
	}()
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-done:
		return true
	case <-t.C:
		return false
	}
}

// acquire reserves a slot without waiting: if there is none, errTransfersBusy.
func (g *transferGate) acquire() (release func(), err error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.active >= maxTransfers {
		return nil, errTransfersBusy
	}
	g.active++
	return func() {
		g.mu.Lock()
		g.active--
		g.mu.Unlock()
	}, nil
}

func (g *transferGate) clock() func(time.Duration) <-chan time.Time {
	if g.after != nil {
		return g.after
	}
	return time.After
}

// progressReader marks moved every time bytes pass.
type progressReader struct {
	r     io.Reader
	moved *atomic.Bool
}

func (p progressReader) Read(b []byte) (int, error) {
	n, err := p.r.Read(b)
	if n > 0 {
		p.moved.Store(true)
	}
	return n, err
}

// withIdleGuard runs fn with a context derived from ctx that is cancelled if a whole transferIdle
// period passes without a byte moving through the readers wrapped with track. With the
// current HTTP client it is enough: in a GET the bytes are counted when reading the body and in a PUT
// when net/http reads the source to write to the socket (if the panel stops reading, the
// socket fills up and the read stops). Before returning it waits for the watchdog to finish.
func (a *App) withIdleGuard(ctx context.Context, fn func(ctx context.Context, track func(io.Reader) io.Reader) error) error {
	after := a.xfer.clock()
	gctx, cancel := context.WithCancelCause(ctx)
	defer cancel(nil) // also if fn panics: the watchdog ends
	var moved atomic.Bool
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			select {
			case <-gctx.Done():
				return
			case <-after(transferIdle):
			}
			if !moved.Swap(false) {
				cancel(errIdle)
				return
			}
		}
	}()
	err := fn(gctx, func(r io.Reader) io.Reader { return progressReader{r: r, moved: &moved} })
	cancel(nil)
	<-done
	if err != nil && errors.Is(context.Cause(gctx), errIdle) {
		return fmt.Errorf("%w: more than %d s without any byte moving", files.ErrTransfer, int(transferIdle.Seconds()))
	}
	return err
}

// errOverCap marks that the source brought more bytes than the cap.
var errOverCap = errors.New("the upload exceeds the maximum")

// capReader fails as soon as the source brings more than left bytes (uploads of unknown size).
type capReader struct {
	r    io.Reader
	left int64
	over bool
}

func (c *capReader) Read(p []byte) (int, error) {
	if int64(len(p)) > c.left+1 {
		p = p[:c.left+1] // one extra byte is enough to know it exceeds
	}
	n, err := c.r.Read(p)
	if int64(n) > c.left {
		c.over = true
		return 0, errOverCap
	}
	c.left -= int64(n)
	return n, err
}

// uploadMax is the cap on an upload (UPLOAD_MAX_BYTES; 4 GiB by default).
func (a *App) uploadMax() int64 {
	if a.cfg.UploadMax > 0 {
		return a.cfg.UploadMax
	}
	return defaultUploadMax
}

func errUploadTooLarge(limit int64) error {
	return fmt.Errorf("%w: the upload exceeds the node's maximum of %s (UPLOAD_MAX_BYTES)", files.ErrTooLarge, humanBytes(limit))
}

func humanBytes(n int64) string {
	switch {
	case n >= 1<<30 && n%(1<<30) == 0:
		return fmt.Sprintf("%d GiB", n>>30)
	case n >= 1<<20 && n%(1<<20) == 0:
		return fmt.Sprintf("%d MiB", n>>20)
	}
	return fmt.Sprintf("%d bytes", n)
}

// serverScoped is satisfied by all the Files* messages.
type serverScoped interface{ GetServerId() string }

// filesRequest returns the envelope's Files* message, or nil if it is not one.
func filesRequest(env *mcsmv1.Envelope) serverScoped {
	switch b := env.Body.(type) {
	case *mcsmv1.Envelope_FilesList:
		return b.FilesList
	case *mcsmv1.Envelope_FilesStat:
		return b.FilesStat
	case *mcsmv1.Envelope_FilesRead:
		return b.FilesRead
	case *mcsmv1.Envelope_FilesWrite:
		return b.FilesWrite
	case *mcsmv1.Envelope_FilesMkdir:
		return b.FilesMkdir
	case *mcsmv1.Envelope_FilesRename:
		return b.FilesRename
	case *mcsmv1.Envelope_FilesDelete:
		return b.FilesDelete
	case *mcsmv1.Envelope_FilesDownload:
		return b.FilesDownload
	case *mcsmv1.Envelope_FilesUpload:
		return b.FilesUpload
	}
	return nil
}

// serverFS returns the confined filesystem of a server on THIS node (spec §9):
// a server_id that is not in the local store is not served. files.Root validates the slug.
func (a *App) serverFS(serverID string) (*files.FS, error) {
	sp, err := a.st.GetSpec(serverID)
	if err != nil {
		return nil, err
	}
	if sp == nil {
		return nil, files.ErrUnknownServer
	}
	root, err := files.Root(a.cfg.DataRoot, sp.Slug)
	if err != nil {
		return nil, err
	}
	return files.New(root), nil
}

// sweepTemps deletes the orphaned upload temporaries (files.SweepTemps) in the data of
// this node's servers. It is launched at startup, in the background: walking a large world takes
// time and new uploads do not wait (their temporaries are recent and not touched).
func (a *App) sweepTemps(ctx context.Context) {
	specs, err := a.st.ListSpecs()
	if err != nil {
		a.log.Warn("temporaries sweep: the servers could not be listed", "err", err)
		return
	}
	for _, sp := range specs {
		if p, err := spec.Parse(sp.SpecJson); err == nil && p.DataPath != "" {
			continue // plan-6 (m3): their data is not in DATA_ROOT/<slug>/data
		}
		root, err := files.Root(a.cfg.DataRoot, sp.Slug)
		if err != nil {
			continue
		}
		if _, err := os.Stat(root); err != nil {
			continue // server without data yet
		}
		n, err := files.New(root).SweepTemps(ctx, orphanTempAge, time.Now())
		if err != nil && ctx.Err() == nil {
			a.log.Warn("temporaries sweep failed", "server", sp.ServerId, "err", err)
		}
		if n > 0 {
			a.log.Info("orphaned upload temporaries deleted", "server", sp.ServerId, "n", n)
		}
		if ctx.Err() != nil {
			return
		}
	}
}

// transfers creates the HTTP transfers client with the node's stored token.
func (a *App) transfers() (*conn.TransferClient, error) {
	creds, err := a.st.Credentials()
	if err != nil {
		return nil, err
	}
	if creds == nil {
		return nil, fmt.Errorf("%w: the agent has no credentials", files.ErrTransfer)
	}
	return conn.NewTransferClient(a.cfg.PanelURL, creds.Token), nil
}

// entryToProto converts an entry. The name comes from disk and may not be UTF-8:
// proto3 rejects those strings and the whole response would be lost when serializing it.
func entryToProto(e files.Entry) *mcsmv1.FileEntry {
	return &mcsmv1.FileEntry{
		Name: validUTF8(e.Name), Dir: e.Dir, Symlink: e.Symlink, Size: uint64(max(e.Size, 0)),
		ModTimeUnixMs: e.ModTime.UnixMilli(), Mode: uint32(e.Mode),
	}
}

// handleFiles serves the panel's Files* (spec §5.3, §6.6) and answers with the same id:
// a *Result, an Ack or an Error with files.Code's code. Transfers answer
// when they finish (the panel waits for the result): Ack when the panel has the whole file
// (download) or when it is written to disk (upload).
//
// ctx must be the agent's life context, not the WS session's: a WebSocket
// drop does not abort a write or a transfer in progress (the panel cuts them over
// HTTP if it abandons them). send is the session's: if it has already ended, the response is dropped.
func (a *App) handleFiles(ctx context.Context, env *mcsmv1.Envelope, send func(*mcsmv1.Envelope) error) {
	req := filesRequest(env)
	if req == nil { // Handle only routes Files* here
		_ = send(errMsg(env.Id, errcode.Unsupported, fmt.Errorf("files message not supported: %T", env.Body)))
		return
	}
	// plan-6: with dataPath the data is outside DATA_ROOT and the agent does not see it.
	if err := a.externalData(req.GetServerId()); err != nil {
		_ = send(errMsg(env.Id, errcode.ExternalData, err))
		return
	}
	if !a.xfer.enter() {
		_ = send(errMsg(env.Id, errcode.Busy, errFilesClosing))
		return
	}
	defer a.xfer.leave()
	resp, err := a.filesOp(ctx, env, req)
	if err != nil {
		code := files.Code(err)
		if errors.Is(err, errTransfersBusy) || errors.Is(err, reconcile.ErrBusy) {
			code = errcode.Busy
		}
		_ = send(errMsg(env.Id, code, err))
		return
	}
	resp.Id = env.Id
	_ = send(resp)
}

func (a *App) filesOp(ctx context.Context, env *mcsmv1.Envelope, req serverScoped) (*mcsmv1.Envelope, error) {
	fsys, err := a.serverFS(req.GetServerId())
	if err != nil {
		return nil, err
	}
	// With the server reserved (backup, restore or blocked without data) nothing is written: a
	// restore sets data aside with rename and what was written would end up in the pre-restore. enter goes
	// before looking at the reservation (see fileWrites). Reads continue: each one sees the
	// old or the new data, whole (an open file keeps its inode after the rename).
	if isFilesMutation(env) {
		leave := a.fileWrites.enter(req.GetServerId())
		defer leave()
		if reason := a.rec.HeldReason(req.GetServerId()); reason != "" {
			return nil, fmt.Errorf("%w: its files cannot be modified while the reservation lasts", reconcile.Busy(reason))
		}
	}
	switch b := env.Body.(type) {
	case *mcsmv1.Envelope_FilesList:
		entries, truncated, err := fsys.List(b.FilesList.Path)
		if err != nil {
			return nil, err
		}
		out := make([]*mcsmv1.FileEntry, 0, len(entries))
		for _, e := range entries {
			out = append(out, entryToProto(e))
		}
		return &mcsmv1.Envelope{Body: &mcsmv1.Envelope_FilesListResult{FilesListResult: &mcsmv1.FilesListResult{Entries: out, Truncated: truncated}}}, nil

	case *mcsmv1.Envelope_FilesStat:
		e, err := fsys.Stat(b.FilesStat.Path)
		if err != nil {
			return nil, err
		}
		return &mcsmv1.Envelope{Body: &mcsmv1.Envelope_FilesStatResult{FilesStatResult: &mcsmv1.FilesStatResult{Entry: entryToProto(e)}}}, nil

	case *mcsmv1.Envelope_FilesRead:
		data, size, err := fsys.Read(b.FilesRead.Path, int64(b.FilesRead.MaxBytes))
		if err != nil {
			return nil, err
		}
		return &mcsmv1.Envelope{Body: &mcsmv1.Envelope_FilesReadResult{FilesReadResult: &mcsmv1.FilesReadResult{Content: data, Size: uint64(size)}}}, nil

	case *mcsmv1.Envelope_FilesWrite:
		err = fsys.Write(b.FilesWrite.Path, b.FilesWrite.Content)
	case *mcsmv1.Envelope_FilesMkdir:
		err = fsys.Mkdir(b.FilesMkdir.Path)
	case *mcsmv1.Envelope_FilesRename:
		err = fsys.Rename(b.FilesRename.From, b.FilesRename.To)
	case *mcsmv1.Envelope_FilesDelete:
		err = fsys.Delete(b.FilesDelete.Path)
	case *mcsmv1.Envelope_FilesDownload:
		err = a.filesDownload(ctx, fsys, b.FilesDownload)
	case *mcsmv1.Envelope_FilesUpload:
		err = a.filesUpload(ctx, fsys, b.FilesUpload)
	}
	if err != nil {
		return nil, err
	}
	return ack(0), nil
}

// filesDownload uploads the file to the panel via PUT /agent/transfer/{id} and confirms when finished.
// The file is opened and the slot reserved before touching the transfer: a bad path or a
// busy node does not consume it.
func (a *App) filesDownload(ctx context.Context, fsys *files.FS, m *mcsmv1.FilesDownload) error {
	f, e, err := fsys.Open(m.Path)
	if err != nil {
		return err
	}
	// Put may leave the body being read for a moment after returning with an error; *os.File allows
	// Close concurrent with Read (the late read fails with os.ErrClosed).
	defer f.Close()
	xfer, err := a.transfers()
	if err != nil {
		return err
	}
	release, err := a.xfer.acquire()
	if err != nil {
		return err
	}
	defer release()
	return a.withIdleGuard(ctx, func(ctx context.Context, track func(io.Reader) io.Reader) error {
		// LimitReader: if the file grows while being sent, what it measured when opened is sent;
		// if it shrinks, Put fails because of Content-Length and the panel does not accept an incomplete file.
		if err := xfer.Put(ctx, m.TransferId, track(io.LimitReader(f, e.Size)), e.Size); err != nil {
			return fmt.Errorf("%w: %v", files.ErrTransfer, err)
		}
		return nil
	})
}

// filesUpload validates the destination and the size, downloads from the panel via GET /agent/transfer/{id} and
// writes atomically as a stream. A truncated body never replaces the file and nothing
// exceeds UPLOAD_MAX_BYTES, not even an upload of unknown size (size = -1 and chunked).
func (a *App) filesUpload(ctx context.Context, fsys *files.FS, m *mcsmv1.FilesUpload) error {
	// Everything that can be rejected without the transfer goes before claiming it.
	if err := fsys.CheckWrite(m.Path); err != nil {
		return err
	}
	limit := a.uploadMax()
	if m.Size > limit {
		return errUploadTooLarge(limit)
	}
	xfer, err := a.transfers()
	if err != nil {
		return err
	}
	release, err := a.xfer.acquire()
	if err != nil {
		return err
	}
	defer release()
	return a.withIdleGuard(ctx, func(ctx context.Context, track func(io.Reader) io.Reader) error {
		body, size, err := xfer.Get(ctx, m.TransferId)
		if err != nil {
			return fmt.Errorf("%w: %v", files.ErrTransfer, err)
		}
		defer body.Close()
		expected := m.Size
		if expected < 0 {
			expected = size
		}
		if size >= 0 && expected != size {
			return fmt.Errorf("%w: the panel announces %d bytes and sends %d", files.ErrTransfer, m.Size, size)
		}
		if expected > limit {
			return errUploadTooLarge(limit)
		}
		src := track(body)
		var capped *capReader
		if expected < 0 { // without a size: WriteFrom would set no cap
			capped = &capReader{r: src, left: limit}
			src = capped
		}
		_, err = fsys.WriteFrom(m.Path, src, expected)
		if err != nil && capped != nil && capped.over {
			return errUploadTooLarge(limit)
		}
		return err
	})
}

// isFilesMutation reports whether the Files* writes to the server's data.
func isFilesMutation(env *mcsmv1.Envelope) bool {
	switch env.Body.(type) {
	case *mcsmv1.Envelope_FilesWrite, *mcsmv1.Envelope_FilesMkdir, *mcsmv1.Envelope_FilesRename,
		*mcsmv1.Envelope_FilesDelete, *mcsmv1.Envelope_FilesUpload:
		return true
	}
	return false
}
