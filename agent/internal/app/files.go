package app

import (
	"context"
	"fmt"
	"io"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/conn"
	"mcsm/agent/internal/errcode"
	"mcsm/agent/internal/files"
)

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
	resp, err := a.filesOp(ctx, env, req)
	if err != nil {
		_ = send(errMsg(env.Id, files.Code(err), err))
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
// El fichero se abre antes de tocar la transferencia: una ruta mala no la consume.
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
	// LimitReader: si el fichero crece mientras se envía, se manda lo que medía al abrirlo; si
	// encoge, Put falla por Content-Length y el panel no recibe un fichero incompleto como bueno.
	if err := xfer.Put(ctx, m.TransferId, io.LimitReader(f, e.Size), e.Size); err != nil {
		return fmt.Errorf("%w: %v", files.ErrTransfer, err)
	}
	return nil
}

// filesUpload valida el destino, descarga del panel por GET /agent/transfer/{id} y escribe de
// forma atómica en streaming. Un cuerpo truncado nunca reemplaza el fichero.
func (a *App) filesUpload(ctx context.Context, fsys *files.FS, m *mcsmv1.FilesUpload) error {
	if err := fsys.CheckWrite(m.Path); err != nil { // fallar antes de consumir la transferencia
		return err
	}
	xfer, err := a.transfers()
	if err != nil {
		return err
	}
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
	_, err = fsys.WriteFrom(m.Path, body, expected)
	return err
}
