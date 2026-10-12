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
)

const (
	// filesShutdownWait es el tope de la espera a los Files* en curso al cerrar el agente.
	filesShutdownWait = 20 * time.Second
	// orphanTempAge: al arrancar se borran los temporales de subidas sin tocar desde hace más.
	orphanTempAge = time.Hour
	// maxTransfers acota las subidas y descargas simultáneas del nodo (descriptores, temporales
	// y conexiones). La siguiente recibe busy al instante, sin consumir su transferencia.
	maxTransfers = 4
	// transferIdle: una transferencia que no mueve un byte durante un periodo entero se corta
	// (se detecta entre 1 y 2 periodos después del último byte).
	transferIdle = 60 * time.Second
)

var (
	errTransfersBusy = fmt.Errorf("el nodo ya tiene %d transferencias de archivos en curso: espera a que termine alguna", maxTransfers)
	errIdle          = errors.New("transferencia inactiva")
	errFilesClosing  = errors.New("el agente se está cerrando: inténtalo de nuevo cuando vuelva a conectar")
)

// transferGate cuenta las transferencias en curso, lleva el reloj del vigilante de
// inactividad y registra los Files* en curso para que el cierre los espere. El valor cero es
// utilizable.
type transferGate struct {
	mu     sync.Mutex
	active int
	// after es el reloj del vigilante (nil → time.After). Solo lo cambian los tests.
	after func(time.Duration) <-chan time.Time
	// ops cuenta los Files* en curso; closed impide que empiecen otros una vez iniciado el cierre
	// (un Add con el contador a cero no puede competir con un Wait en marcha).
	ops    sync.WaitGroup
	closed bool
}

// enter registra un Files* que empieza; false si el agente ya se está cerrando.
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

// wait cierra la entrada a Files* nuevos y espera, como mucho d, a que terminen los que están
// en curso. Al cerrar, el contexto de vida ya está cancelado: las transferencias se cortan y
// WriteFrom borra su temporal; lo que espera esto es esa limpieza (y una escritura o un borrado
// que estén a medias), para que el proceso no salga dejando temporales huérfanos. Devuelve
// false si venció el plazo.
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

// acquire reserva un hueco sin esperar: si no hay, errTransfersBusy.
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

// progressReader marca moved cada vez que pasan bytes.
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

// withIdleGuard ejecuta fn con un contexto derivado de ctx que se cancela si pasa un periodo
// entero de transferIdle sin que se mueva un byte por los lectores envueltos con track. Con
// el cliente HTTP actual basta: en un GET los bytes se cuentan al leer el cuerpo y en un PUT
// cuando net/http lee el origen para escribir en el socket (si el panel deja de leer, el
// socket se llena y la lectura se detiene). Antes de volver espera a que el vigilante acabe.
func (a *App) withIdleGuard(ctx context.Context, fn func(ctx context.Context, track func(io.Reader) io.Reader) error) error {
	after := a.xfer.clock()
	gctx, cancel := context.WithCancelCause(ctx)
	defer cancel(nil) // también si fn entra en pánico: el vigilante termina
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
		return fmt.Errorf("%w: más de %d s sin moverse ningún byte", files.ErrTransfer, int(transferIdle.Seconds()))
	}
	return err
}

// errOverCap marca que el origen trajo más bytes que el tope.
var errOverCap = errors.New("la subida supera el máximo")

// capReader falla en cuanto el origen trae más de left bytes (subidas sin tamaño conocido).
type capReader struct {
	r    io.Reader
	left int64
	over bool
}

func (c *capReader) Read(p []byte) (int, error) {
	if int64(len(p)) > c.left+1 {
		p = p[:c.left+1] // un byte de más basta para saber que se pasa
	}
	n, err := c.r.Read(p)
	if int64(n) > c.left {
		c.over = true
		return 0, errOverCap
	}
	c.left -= int64(n)
	return n, err
}

// uploadMax es el tope de una subida (UPLOAD_MAX_BYTES; por defecto 4 GiB).
func (a *App) uploadMax() int64 {
	if a.cfg.UploadMax > 0 {
		return a.cfg.UploadMax
	}
	return defaultUploadMax
}

func errUploadTooLarge(limit int64) error {
	return fmt.Errorf("%w: la subida supera el máximo de %s del nodo (UPLOAD_MAX_BYTES)", files.ErrTooLarge, humanBytes(limit))
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

// serverScoped lo cumplen todos los mensajes Files*.
type serverScoped interface{ GetServerId() string }

// filesRequest devuelve el mensaje Files* del envelope, o nil si no lo es.
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

// serverFS devuelve el sistema de archivos confinado de un servidor de ESTE nodo (spec §9):
// un server_id que no está en el store local no se atiende. files.Root valida el slug.
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

// sweepTemps borra los temporales huérfanos de subidas (files.SweepTemps) en los data de los
// servidores de este nodo. Se lanza al arrancar, en segundo plano: recorrer un mundo grande lleva
// su tiempo y las subidas nuevas no esperan (sus temporales son recientes y no se tocan).
func (a *App) sweepTemps(ctx context.Context) {
	specs, err := a.st.ListSpecs()
	if err != nil {
		a.log.Warn("barrido de temporales: no se pudieron listar los servidores", "err", err)
		return
	}
	for _, sp := range specs {
		root, err := files.Root(a.cfg.DataRoot, sp.Slug)
		if err != nil {
			continue
		}
		if _, err := os.Stat(root); err != nil {
			continue // servidor sin datos todavía
		}
		n, err := files.New(root).SweepTemps(ctx, orphanTempAge, time.Now())
		if err != nil && ctx.Err() == nil {
			a.log.Warn("barrido de temporales fallido", "server", sp.ServerId, "err", err)
		}
		if n > 0 {
			a.log.Info("borrados temporales huérfanos de subidas", "server", sp.ServerId, "n", n)
		}
		if ctx.Err() != nil {
			return
		}
	}
}

// transfers crea el cliente HTTP de transferencias con el token guardado del nodo.
func (a *App) transfers() (*conn.TransferClient, error) {
	creds, err := a.st.Credentials()
	if err != nil {
		return nil, err
	}
	if creds == nil {
		return nil, fmt.Errorf("%w: el agente no tiene credenciales", files.ErrTransfer)
	}
	return conn.NewTransferClient(a.cfg.PanelURL, creds.Token), nil
}

// entryToProto convierte una entrada. El nombre viene del disco y puede no ser UTF-8:
// proto3 rechaza esos string y la respuesta entera se perdería al serializarla.
func entryToProto(e files.Entry) *mcsmv1.FileEntry {
	return &mcsmv1.FileEntry{
		Name: validUTF8(e.Name), Dir: e.Dir, Symlink: e.Symlink, Size: uint64(max(e.Size, 0)),
		ModTimeUnixMs: e.ModTime.UnixMilli(), Mode: uint32(e.Mode),
	}
}

// handleFiles atiende los Files* del panel (spec §5.3, §6.6) y responde con el mismo id:
// un *Result, un Ack o un Error con el código de files.Code. Las transferencias responden
// al terminar (el panel espera el resultado): Ack cuando el panel tiene el fichero entero
// (descarga) o cuando está escrito en disco (subida).
//
// ctx debe ser el contexto de vida del agente, no el de la sesión WS: un corte del
// WebSocket no aborta una escritura ni una transferencia en curso (el panel las corta por
// HTTP si las abandona). send sí es el de la sesión: si ya terminó, la respuesta se descarta.
func (a *App) handleFiles(ctx context.Context, env *mcsmv1.Envelope, send func(*mcsmv1.Envelope) error) {
	req := filesRequest(env)
	if req == nil { // Handle solo enruta Files* aquí
		_ = send(errMsg(env.Id, errcode.Unsupported, fmt.Errorf("mensaje de archivos no soportado: %T", env.Body)))
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
	// Con el servidor reservado (copia, restauración o bloqueado sin data) no se escribe: una
	// restauración aparta data con rename y lo escrito acabaría en el pre-restore. enter va
	// antes de mirar la reserva (ver fileWrites). Las lecturas siguen: cada una ve el data
	// viejo o el nuevo, entero (un fichero abierto conserva su inodo tras el rename).
	if isFilesMutation(env) {
		leave := a.fileWrites.enter(req.GetServerId())
		defer leave()
		if a.rec.Held(req.GetServerId()) {
			return nil, fmt.Errorf("%w: no se pueden modificar sus archivos hasta que termine", reconcile.ErrBusy)
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

// filesDownload sube el fichero al panel por PUT /agent/transfer/{id} y confirma al terminar.
// El fichero se abre y el hueco se reserva antes de tocar la transferencia: una ruta mala o un
// nodo ocupado no la consumen.
func (a *App) filesDownload(ctx context.Context, fsys *files.FS, m *mcsmv1.FilesDownload) error {
	f, e, err := fsys.Open(m.Path)
	if err != nil {
		return err
	}
	// Put puede dejar el cuerpo leyéndose un instante tras volver con error; *os.File admite
	// Close concurrente con Read (la lectura tardía falla con os.ErrClosed).
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
		// LimitReader: si el fichero crece mientras se envía, se manda lo que medía al abrirlo;
		// si encoge, Put falla por Content-Length y el panel no da por bueno un fichero incompleto.
		if err := xfer.Put(ctx, m.TransferId, track(io.LimitReader(f, e.Size)), e.Size); err != nil {
			return fmt.Errorf("%w: %v", files.ErrTransfer, err)
		}
		return nil
	})
}

// filesUpload valida el destino y el tamaño, descarga del panel por GET /agent/transfer/{id} y
// escribe de forma atómica en streaming. Un cuerpo truncado nunca reemplaza el fichero y nada
// supera UPLOAD_MAX_BYTES, tampoco una subida sin tamaño conocido (size = -1 y chunked).
func (a *App) filesUpload(ctx context.Context, fsys *files.FS, m *mcsmv1.FilesUpload) error {
	// Todo lo que se puede rechazar sin la transferencia va antes de reclamarla.
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
			return fmt.Errorf("%w: el panel anuncia %d bytes y envía %d", files.ErrTransfer, m.Size, size)
		}
		if expected > limit {
			return errUploadTooLarge(limit)
		}
		src := track(body)
		var capped *capReader
		if expected < 0 { // sin tamaño: WriteFrom no pondría tope
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

// isFilesMutation indica si el Files* escribe en el data del servidor.
func isFilesMutation(env *mcsmv1.Envelope) bool {
	switch env.Body.(type) {
	case *mcsmv1.Envelope_FilesWrite, *mcsmv1.Envelope_FilesMkdir, *mcsmv1.Envelope_FilesRename,
		*mcsmv1.Envelope_FilesDelete, *mcsmv1.Envelope_FilesUpload:
		return true
	}
	return false
}
