import { Component, lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useBlocker } from "@tanstack/react-router";
import { Download, File, FileText, Folder, FolderPlus, Link2, Loader2, Pencil, RefreshCw, Trash2, Upload, X } from "lucide-react";
import { joinPath, parentPath, type FileEntryDto } from "@mcsm/shared";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ApiError } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { breadcrumbs, downloadBlocker, entryOpenKind, filesApi, isSaveShortcut, leaveWarning, progressPct, sortEntries, startDownload, uploadClashes, uploadFile } from "@/lib/files";
import { NameDialog } from "./name-dialog";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useTabGuard } from "@/components/guarded-tabs";

// CodeMirror is heavy: it is only downloaded when a file is opened.
const FileEditor = lazy(() => import("./file-editor").then((m) => ({ default: m.FileEditor })));

interface UploadItem { name: string; sent: number; total: number; error?: string }
type NameAction = { kind: "mkdir" } | { kind: "rename"; entry: FileEntryDto } | null;

const errText = (e: unknown) => (e instanceof ApiError ? e.message : "Unexpected error");

/** If downloading the editor chunk fails, say so instead of staying in the loading state. */
class EditorBoundary extends Component<{ children: ReactNode; onClose(): void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className="flex flex-col items-start gap-2 text-sm text-bad">
        <p>Could not load the editor.</p>
        <Button size="sm" variant="secondary" onClick={this.props.onClose}>Back to the list</Button>
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
  const [checking, setChecking] = useState<string | null>(null); // download being checked
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const lastDelete = useRef<FileEntryDto | null>(null); // the title does not flicker during the close animation
  if (toDelete) lastDelete.current = toDelete;
  const shownDelete = toDelete ?? lastDelete.current;
  const fileInput = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);
  const qc = useQueryClient();
  const offline = nodeOnline === false;

  // Unsaved changes or an upload in progress (leaving cancels it): blocks the router navigation
  // (dialog), the server tab change and warns when closing/reloading the browser tab.
  const warning = leaveWarning({ dirty, uploading, file: editing });
  const guarded = warning !== null;
  const lastWarning = useRef(warning); // the text does not change while the dialog closes
  if (warning) lastWarning.current = warning;
  const blocker = useBlocker({ shouldBlockFn: () => true, disabled: !guarded, enableBeforeUnload: () => guarded, withResolver: true });

  useTabGuard(guarded, warning ?? undefined);
  // On unmount (tab change), whatever is still uploading is cancelled.
  useEffect(() => () => abort.current?.abort(), []);

  // With the editor open, Ctrl/Cmd+S outside the editor must not open the browser's “Save page as…”.
  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => { if (isSaveShortcut(e)) e.preventDefault(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing]);

  // While the tab is mounted, dropping a file outside the zone does not open the file in the browser.
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
    try {
      await filesApi.uploadCheck(serverId); // plan-9: the reason for a 409 before starting, not a cut halfway
    } catch (e) {
      setUploads(files.map((f) => ({ name: f.name, sent: 0, total: f.size, error: errText(e) })));
      abort.current = null;
      setUploading(false);
      return;
    }
    for (const [i, f] of files.entries()) {
      const update = (patch: Partial<UploadItem>) => setUploads((u) => u.map((x, j) => (j === i ? { ...x, ...patch } : x)));
      if (ctl.signal.aborted) { update({ error: "Upload cancelled" }); continue; }
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
    setUploads((u) => u.filter((x) => x.error)); // the successful ones disappear; the errors stay in view
  };

  const upload = (picked: FileList | null) => {
    if (!picked?.length || uploading || offline || !list.data) return; // without a listing, replacements cannot be detected
    const files = [...picked];
    const clash = uploadClashes(files.map((f) => f.name), names);
    if (clash.length) return setReplaceAsk({ files, clash });
    void startUpload(files, path);
  };

  // Before the browser starts the download (and swallows the error), a stat checks that
  // the node responds and the file is still there; if not, the reason is shown here.
  const download = async (e: FileEntryDto) => {
    const p = joinPath(path, e.name);
    setDownloadError(null);
    setChecking(e.name);
    let check: Parameters<typeof downloadBlocker>[0];
    try {
      check = { entry: await filesApi.stat(serverId, p) };
    } catch (err) {
      check = { error: err };
    }
    setChecking(null);
    const problem = downloadBlocker(check);
    if (problem) setDownloadError(`Could not download ${e.name}: ${problem}`);
    else startDownload(filesApi.downloadUrl(serverId, p), e.name);
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
        title="Unsaved changes"
        description={`There are unsaved changes in ${editing ?? "the file"}. If you close the editor they will be lost.`}
        confirmLabel="Discard changes"
        onConfirm={closeEditor}
        onCancel={() => setAskClose(false)}
      />
      <ConfirmDialog
        open={blocker.status === "blocked"}
        title={lastWarning.current?.title ?? "Leave"}
        description={lastWarning.current?.description ?? ""}
        confirmLabel={lastWarning.current?.confirmLabel ?? "Leave"}
        cancelLabel="Stay"
        onConfirm={() => blocker.proceed?.()}
        onCancel={() => blocker.reset?.()}
      />
    </>
  );

  if (editing) {
    return (
      <>
        <EditorBoundary onClose={closeEditor}>
        <Suspense fallback={<div className="flex items-center gap-2 p-4 text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading editor…</div>}>
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
        <nav aria-label="Path" className="flex flex-wrap items-center gap-1 font-mono text-sm">
          {breadcrumbs(path).map((b, i, all) => (
            <span key={b.path} className="flex items-center gap-1">
              {i > 0 && <span className="text-muted-foreground">/</span>}
              {i === all.length - 1 ? <span>{b.name}</span> : <button type="button" className="text-info hover:underline" onClick={() => setPath(b.path)}>{b.name}</button>}
            </span>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => { upload(e.target.files); e.target.value = ""; }} />
          <Button size="sm" variant="secondary" disabled={offline || uploading || !list.data} onClick={() => fileInput.current?.click()}><Upload /> Upload</Button>
          <Button size="sm" variant="secondary" disabled={offline} onClick={() => { nameMut.reset(); setNameAction({ kind: "mkdir" }); }}><FolderPlus /> New folder</Button>
          <Button size="icon-sm" variant="ghost" aria-label="Refresh" disabled={offline} onClick={() => void refresh()}><RefreshCw /></Button>
        </div>
      </div>

      {offline && <p className="text-sm text-warn">The node is offline: files are not available.</p>}
      {uploads.map((u, i) => (
        <div key={i} className="flex flex-wrap items-center gap-3 text-sm">
          <span className="w-64 truncate font-mono">{u.name}</span>
          {u.error ? <span role="alert" className="text-bad">{u.error}</span> : (
            <>
              <div className="h-2 w-48 overflow-hidden rounded bg-muted"><div className="h-full bg-primary" style={{ width: `${progressPct(u.sent, u.total)}%` }} /></div>
              <span className="text-muted-foreground">{progressPct(u.sent, u.total)} % of {formatBytes(u.total)}</span>
            </>
          )}
        </div>
      ))}
      {uploading && <div><Button size="xs" variant="secondary" onClick={() => abort.current?.abort()}><X /> Cancel upload</Button></div>}
      {list.isError && <p role="alert" className="text-sm text-bad">{errText(list.error)}</p>}
      {downloadError && (
        <div role="alert" className="flex items-center gap-2 text-sm text-bad">
          <span>{downloadError}</span>
          <Button size="icon-xs" variant="ghost" aria-label="Close notice" onClick={() => setDownloadError(null)}><X /></Button>
        </div>
      )}

      <Table>
        <TableHeader>
          <TableRow><TableHead>Name</TableHead><TableHead className="w-28 text-right">Size</TableHead><TableHead className="w-44">Modified</TableHead><TableHead className="w-32" /></TableRow>
        </TableHeader>
        <TableBody>
          {path !== "/" && (
            <TableRow className="cursor-pointer" onClick={() => setPath(parentPath(path))}>
              <TableCell colSpan={4} className="font-mono text-muted-foreground">..</TableCell>
            </TableRow>
          )}
          {list.isPending && !offline && <TableRow><TableCell colSpan={4} className="text-muted-foreground"><Loader2 className="inline size-4 animate-spin" /> Loading…</TableCell></TableRow>}
          {entries?.length === 0 && <TableRow><TableCell colSpan={4} className="text-muted-foreground">Empty folder. Drag files here to upload them.</TableCell></TableRow>}
          {entries?.map((e) => {
            const kind = entryOpenKind(e);
            const Icon = e.dir ? Folder : e.symlink ? Link2 : kind === "edit" ? FileText : File;
            const clickable = kind !== "download";
            return (
              <TableRow key={e.name}>
                <TableCell>
                  <button type="button" disabled={!clickable} className="flex items-center gap-2 font-mono text-sm enabled:hover:underline disabled:cursor-default" onClick={() => open(e)} title={clickable ? undefined : "Cannot be opened in the editor: download it"}>
                    <Icon className={`size-4 ${e.dir ? "text-info" : "text-muted-foreground"}`} />{e.name}
                  </button>
                </TableCell>
                <TableCell className="text-right text-muted-foreground">{e.dir ? "—" : formatBytes(e.size)}</TableCell>
                <TableCell className="text-muted-foreground">{new Date(e.modifiedAt).toLocaleString()}</TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    {!e.dir && (
                      <Button size="icon-xs" variant="ghost" aria-label={`Download ${e.name}`} disabled={offline || checking === e.name} onClick={() => void download(e)}>
                        {checking === e.name ? <Loader2 className="animate-spin" /> : <Download />}
                      </Button>
                    )}
                    <Button size="icon-xs" variant="ghost" aria-label={`Rename ${e.name}`} disabled={offline} onClick={() => { nameMut.reset(); setNameAction({ kind: "rename", entry: e }); }}><Pencil /></Button>
                    <Button size="icon-xs" variant="ghost" aria-label={`Delete ${e.name}`} disabled={offline} onClick={() => { del.reset(); setToDelete(e); }}><Trash2 /></Button>
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {list.data?.truncated && <p className="text-sm text-warn">The folder has too many entries: only the first 5000 are shown.</p>}

      <NameDialog
        open={nameAction !== null}
        title={nameAction?.kind === "rename" ? `Rename “${nameAction.entry.name}”` : "New folder"}
        confirmLabel={nameAction?.kind === "rename" ? "Rename" : "Create"}
        initial={nameAction?.kind === "rename" ? nameAction.entry.name : ""}
        existing={names}
        pending={nameMut.isPending}
        error={nameMut.error ? errText(nameMut.error) : null}
        onConfirm={(n) => nameMut.mutate(n)}
        onOpenChange={(o) => { if (!o) setNameAction(null); }}
      />
      <ConfirmDialog
        open={toDelete !== null}
        title={shownDelete ? `Delete “${shownDelete.name}”` : "Delete"}
        description={shownDelete?.dir ? "The folder and all its contents will be deleted. This cannot be undone." : "The file will be deleted. This cannot be undone."}
        confirmLabel="Delete"
        pending={del.isPending}
        error={del.error ? errText(del.error) : null}
        onConfirm={() => { if (toDelete) del.mutate(toDelete); }}
        onCancel={() => setToDelete(null)}
      />
      <ConfirmDialog
        open={replaceAsk !== null}
        title="Replace files"
        description={replaceAsk ? `${replaceAsk.clash.join(", ")} already exists in this folder. Replace?` : ""}
        confirmLabel="Replace"
        onConfirm={() => { const a = replaceAsk; setReplaceAsk(null); if (a) void startUpload(a.files, path); }}
        onCancel={() => setReplaceAsk(null)}
      />
      {dialogs}
    </div>
  );
}
