import { Component, lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useBlocker } from "@tanstack/react-router";
import { Download, File, FileText, Folder, FolderPlus, Link2, Loader2, Pencil, RefreshCw, Trash2, Upload, X } from "lucide-react";
import { joinPath, parentPath, type FileEntryDto } from "@mcsm/shared";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ApiError } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { breadcrumbs, entryOpenKind, filesApi, isSaveShortcut, progressPct, sortEntries, uploadClashes, uploadFile } from "@/lib/files";
import { NameDialog } from "./name-dialog";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useTabGuard } from "@/components/guarded-tabs";

// CodeMirror pesa: solo se descarga al abrir un fichero.
const FileEditor = lazy(() => import("./file-editor").then((m) => ({ default: m.FileEditor })));

interface UploadItem { name: string; sent: number; total: number; error?: string }
type NameAction = { kind: "mkdir" } | { kind: "rename"; entry: FileEntryDto } | null;

const errText = (e: unknown) => (e instanceof ApiError ? e.message : "Error inesperado");

/** Si falla la descarga del chunk del editor, lo dice en vez de quedarse cargando. */
class EditorBoundary extends Component<{ children: ReactNode; onClose(): void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className="flex flex-col items-start gap-2 text-sm text-red-400">
        <p>No se pudo cargar el editor.</p>
        <Button size="sm" variant="secondary" onClick={this.props.onClose}>Volver a la lista</Button>
      </div>
    );
  }
}

interface Props {
  serverId: string;
  nodeOnline?: boolean;
}

export function FileBrowser({ serverId, nodeOnline }: Props) {
  const [path, setPath] = useState("/");
  const [editing, setEditing] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [askClose, setAskClose] = useState(false);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const [replaceAsk, setReplaceAsk] = useState<{ files: File[]; clash: string[] } | null>(null);
  const [nameAction, setNameAction] = useState<NameAction>(null);
  const [toDelete, setToDelete] = useState<FileEntryDto | null>(null);
  const lastDelete = useRef<FileEntryDto | null>(null); // el título no parpadea durante la animación de cierre
  if (toDelete) lastDelete.current = toDelete;
  const shownDelete = toDelete ?? lastDelete.current;
  const fileInput = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);
  const qc = useQueryClient();
  const offline = nodeOnline === false;

  // Cambios sin guardar: bloquea la navegación del router (diálogo) y avisa al cerrar/recargar la pestaña del navegador.
  const blocker = useBlocker({ shouldBlockFn: () => true, disabled: !dirty, enableBeforeUnload: () => dirty, withResolver: true });

  useTabGuard(dirty); // también protege el cambio de pestaña
  // Al desmontar (cambio de pestaña) se cancela lo que siga subiéndose.
  useEffect(() => () => abort.current?.abort(), []);

  // Con el editor abierto, Ctrl/Cmd+S fuera del editor no debe abrir «Guardar página como…» del navegador.
  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => { if (isSaveShortcut(e)) e.preventDefault(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing]);

  // Mientras la pestaña está montada, soltar un fichero fuera de la zona no abre el fichero en el navegador.
  useEffect(() => {
    const stop = (e: DragEvent) => e.preventDefault();
    window.addEventListener("dragover", stop);
    window.addEventListener("drop", stop);
    return () => { window.removeEventListener("dragover", stop); window.removeEventListener("drop", stop); };
  }, []);

  const list = useQuery({
    queryKey: ["files", serverId, path],
    queryFn: () => filesApi.list(serverId, path),
    enabled: !offline && !editing,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["files", serverId] });
  const entries = list.data ? sortEntries(list.data.entries) : undefined;
  const names = entries?.map((e) => e.name) ?? [];

  const nameMut = useMutation({
    mutationFn: async (name: string) => {
      if (nameAction?.kind === "mkdir") return filesApi.mkdir(serverId, joinPath(path, name));
      if (nameAction?.kind === "rename") return filesApi.rename(serverId, joinPath(path, nameAction.entry.name), joinPath(path, name));
    },
    onSuccess: () => { setNameAction(null); void refresh(); },
  });
  const del = useMutation({
    mutationFn: (e: FileEntryDto) => filesApi.remove(serverId, joinPath(path, e.name)),
    onSuccess: () => { setToDelete(null); void refresh(); },
  });

  const startUpload = async (files: File[], dest: string) => {
    const ctl = new AbortController();
    abort.current = ctl;
    setUploading(true);
    setUploads(files.map((f) => ({ name: f.name, sent: 0, total: f.size })));
    for (const [i, f] of files.entries()) {
      const update = (patch: Partial<UploadItem>) => setUploads((u) => u.map((x, j) => (j === i ? { ...x, ...patch } : x)));
      if (ctl.signal.aborted) { update({ error: "Subida cancelada" }); continue; }
      try {
        await uploadFile(serverId, joinPath(dest, f.name), f, (sent, total) => update({ sent, total }), ctl.signal);
        update({ sent: f.size });
      } catch (e) {
        update({ error: errText(e) });
      }
    }
    abort.current = null;
    setUploading(false);
    void refresh();
    setUploads((u) => u.filter((x) => x.error)); // las correctas desaparecen; los errores se quedan a la vista
  };

  const upload = (picked: FileList | null) => {
    if (!picked?.length || uploading || offline || !list.data) return; // sin listado no se pueden detectar reemplazos
    const files = [...picked];
    const clash = uploadClashes(files.map((f) => f.name), names);
    if (clash.length) return setReplaceAsk({ files, clash });
    void startUpload(files, path);
  };

  const open = (e: FileEntryDto) => {
    const kind = entryOpenKind(e);
    if (kind === "dir") setPath(joinPath(path, e.name));
    else if (kind === "edit") setEditing(joinPath(path, e.name));
  };

  const closeEditor = () => { setEditing(null); setDirty(false); setAskClose(false); void refresh(); };

  const dialogs = (
    <>
      <ConfirmDialog
        open={askClose}
        title="Cambios sin guardar"
        description={`Hay cambios sin guardar en ${editing ?? "el fichero"}. Si cierras el editor se perderán.`}
        confirmLabel="Descartar cambios"
        onConfirm={closeEditor}
        onCancel={() => setAskClose(false)}
      />
      <ConfirmDialog
        open={blocker.status === "blocked"}
        title="Cambios sin guardar"
        description={`Hay cambios sin guardar en ${editing ?? "el fichero"}. Si sales de esta página se perderán.`}
        confirmLabel="Salir y descartar"
        cancelLabel="Seguir editando"
        onConfirm={() => blocker.proceed?.()}
        onCancel={() => blocker.reset?.()}
      />
    </>
  );

  if (editing) {
    return (
      <>
        <EditorBoundary onClose={closeEditor}>
        <Suspense fallback={<div className="flex items-center gap-2 p-4 text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Cargando editor…</div>}>
          <FileEditor key={editing} serverId={serverId} path={editing} onDirtyChange={setDirty} onClose={() => (dirty ? setAskClose(true) : closeEditor())} />
        </Suspense>
        </EditorBoundary>
        {dialogs}
      </>
    );
  }

  return (
    <div
      className="flex flex-col gap-3"
      onDragOver={(e) => { if (!offline) e.preventDefault(); }}
      onDrop={(e) => { e.preventDefault(); upload(e.dataTransfer.files); }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <nav aria-label="Ruta" className="flex flex-wrap items-center gap-1 font-mono text-sm">
          {breadcrumbs(path).map((b, i, all) => (
            <span key={b.path} className="flex items-center gap-1">
              {i > 0 && <span className="text-muted-foreground">/</span>}
              {i === all.length - 1 ? <span>{b.name}</span> : <button type="button" className="text-sky-400 hover:underline" onClick={() => setPath(b.path)}>{b.name}</button>}
            </span>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => { upload(e.target.files); e.target.value = ""; }} />
          <Button size="sm" variant="secondary" disabled={offline || uploading || !list.data} onClick={() => fileInput.current?.click()}><Upload /> Subir</Button>
          <Button size="sm" variant="secondary" disabled={offline} onClick={() => { nameMut.reset(); setNameAction({ kind: "mkdir" }); }}><FolderPlus /> Nueva carpeta</Button>
          <Button size="icon-sm" variant="ghost" aria-label="Refrescar" disabled={offline} onClick={() => void refresh()}><RefreshCw /></Button>
        </div>
      </div>

      {offline && <p className="text-sm text-amber-400">El nodo está desconectado: los archivos no están disponibles.</p>}
      {uploads.map((u, i) => (
        <div key={i} className="flex flex-wrap items-center gap-3 text-sm">
          <span className="w-64 truncate font-mono">{u.name}</span>
          {u.error ? <span role="alert" className="text-red-400">{u.error}</span> : (
            <>
              <div className="h-2 w-48 overflow-hidden rounded bg-muted"><div className="h-full bg-primary" style={{ width: `${progressPct(u.sent, u.total)}%` }} /></div>
              <span className="text-muted-foreground">{progressPct(u.sent, u.total)} % de {formatBytes(u.total)}</span>
            </>
          )}
        </div>
      ))}
      {uploading && <div><Button size="xs" variant="secondary" onClick={() => abort.current?.abort()}><X /> Cancelar subida</Button></div>}
      {list.isError && <p role="alert" className="text-sm text-red-400">{errText(list.error)}</p>}

      <Table>
        <TableHeader>
          <TableRow><TableHead>Nombre</TableHead><TableHead className="w-28 text-right">Tamaño</TableHead><TableHead className="w-44">Modificado</TableHead><TableHead className="w-32" /></TableRow>
        </TableHeader>
        <TableBody>
          {path !== "/" && (
            <TableRow className="cursor-pointer" onClick={() => setPath(parentPath(path))}>
              <TableCell colSpan={4} className="font-mono text-muted-foreground">..</TableCell>
            </TableRow>
          )}
          {list.isPending && !offline && <TableRow><TableCell colSpan={4} className="text-muted-foreground"><Loader2 className="inline size-4 animate-spin" /> Cargando…</TableCell></TableRow>}
          {entries?.length === 0 && <TableRow><TableCell colSpan={4} className="text-muted-foreground">Carpeta vacía. Arrastra ficheros aquí para subirlos.</TableCell></TableRow>}
          {entries?.map((e) => {
            const kind = entryOpenKind(e);
            const Icon = e.dir ? Folder : e.symlink ? Link2 : kind === "edit" ? FileText : File;
            const clickable = kind !== "download";
            return (
              <TableRow key={e.name}>
                <TableCell>
                  <button type="button" disabled={!clickable} className="flex items-center gap-2 font-mono text-sm enabled:hover:underline disabled:cursor-default" onClick={() => open(e)} title={clickable ? undefined : "No se puede abrir en el editor: descárgalo"}>
                    <Icon className={`size-4 ${e.dir ? "text-sky-400" : "text-muted-foreground"}`} />{e.name}
                  </button>
                </TableCell>
                <TableCell className="text-right text-muted-foreground">{e.dir ? "—" : formatBytes(e.size)}</TableCell>
                <TableCell className="text-muted-foreground">{new Date(e.modifiedAt).toLocaleString()}</TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    {!e.dir && (offline
                      ? <Button size="icon-xs" variant="ghost" aria-label={`Descargar ${e.name}`} disabled><Download /></Button>
                      : <Button asChild size="icon-xs" variant="ghost" aria-label={`Descargar ${e.name}`}><a href={filesApi.downloadUrl(serverId, joinPath(path, e.name))} download={e.name}><Download /></a></Button>)}
                    <Button size="icon-xs" variant="ghost" aria-label={`Renombrar ${e.name}`} disabled={offline} onClick={() => { nameMut.reset(); setNameAction({ kind: "rename", entry: e }); }}><Pencil /></Button>
                    <Button size="icon-xs" variant="ghost" aria-label={`Borrar ${e.name}`} disabled={offline} onClick={() => { del.reset(); setToDelete(e); }}><Trash2 /></Button>
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {list.data?.truncated && <p className="text-sm text-amber-400">La carpeta tiene demasiadas entradas: solo se muestran las primeras 5000.</p>}

      <NameDialog
        open={nameAction !== null}
        title={nameAction?.kind === "rename" ? `Renombrar «${nameAction.entry.name}»` : "Nueva carpeta"}
        confirmLabel={nameAction?.kind === "rename" ? "Renombrar" : "Crear"}
        initial={nameAction?.kind === "rename" ? nameAction.entry.name : ""}
        existing={names}
        pending={nameMut.isPending}
        error={nameMut.error ? errText(nameMut.error) : null}
        onConfirm={(n) => nameMut.mutate(n)}
        onOpenChange={(o) => { if (!o) setNameAction(null); }}
      />
      <ConfirmDialog
        open={toDelete !== null}
        title={shownDelete ? `Borrar «${shownDelete.name}»` : "Borrar"}
        description={shownDelete?.dir ? "Se borrará la carpeta y todo su contenido. No se puede deshacer." : "Se borrará el fichero. No se puede deshacer."}
        confirmLabel="Borrar"
        pending={del.isPending}
        error={del.error ? errText(del.error) : null}
        onConfirm={() => { if (toDelete) del.mutate(toDelete); }}
        onCancel={() => setToDelete(null)}
      />
      <ConfirmDialog
        open={replaceAsk !== null}
        title="Reemplazar ficheros"
        description={replaceAsk ? `Ya existe ${replaceAsk.clash.join(", ")} en esta carpeta. ¿Reemplazar?` : ""}
        confirmLabel="Reemplazar"
        onConfirm={() => { const a = replaceAsk; setReplaceAsk(null); if (a) void startUpload(a.files, path); }}
        onCancel={() => setReplaceAsk(null)}
      />
      {dialogs}
    </div>
  );
}
