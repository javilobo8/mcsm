import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2, Save, X } from "lucide-react";
import type { EditorView } from "codemirror";
import { baseName, editorLanguage } from "@mcsm/shared";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { canStartSave, filesApi, isClean } from "@/lib/files";
import { CodeEditor } from "./code-editor";

const errText = (e: unknown) => (e instanceof ApiError ? e.message : "Error inesperado");

/** Editor de un fichero de texto (≤ 2 MiB). Guarda con el botón o Ctrl/Cmd+S. */
export function FileEditor({ serverId, path, onClose, onDirtyChange }: { serverId: string; path: string; onClose(): void; onDirtyChange?(dirty: boolean): void }) {
  const file = useQuery({ queryKey: ["file-content", serverId, path], queryFn: () => filesApi.read(serverId, path), gcTime: 0, staleTime: Infinity });
  const view = useRef<EditorView | null>(null);
  const [dirty, setDirty] = useState(false);
  // Último contenido conocido en disco (lo cargado, o lo último guardado con éxito).
  const saved = useRef<string | null>(null);
  if (saved.current === null && file.data) saved.current = file.data.content;
  const inFlight = useRef(false);
  const save = useMutation({
    mutationFn: (content: string) => filesApi.write(serverId, path, content),
    onSettled: () => { inFlight.current = false; },
    onSuccess: (_, content) => {
      saved.current = content;
      // Si se tecleó mientras el guardado estaba en vuelo, sigue sucio.
      setDirty(view.current ? !isClean(view.current.state.doc, content) : false);
    },
  });
  const doSave = () => {
    if (!view.current || !canStartSave({ hasView: true, dirty, inFlight: inFlight.current })) return;
    inFlight.current = true;
    save.mutate(view.current.state.doc.toString());
  };
  // El padre decide si cerrar con cambios sin guardar (diálogo propio, no window.confirm).
  const report = useRef(onDirtyChange);
  useEffect(() => { report.current = onDirtyChange; });
  useEffect(() => { report.current?.(dirty); }, [dirty]);
  useEffect(() => () => report.current?.(false), []);
  const name = baseName(path);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 font-mono text-sm">
          <span>{path}</span>
          {file.data && <span className="text-muted-foreground">{formatBytes(file.data.size)}</span>}
          {dirty && <span className="text-amber-400">· sin guardar</span>}
          {!dirty && save.isSuccess && <span className="text-emerald-400">· guardado</span>}
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" disabled={!dirty || save.isPending || !file.data} onClick={doSave}>{save.isPending ? <Loader2 className="animate-spin" /> : <Save />} Guardar</Button>
          <Button size="sm" variant="ghost" onClick={onClose}><X /> Cerrar</Button>
        </div>
      </div>
      {name === "server.properties" && (
        <p className="text-sm text-muted-foreground">Las propiedades definidas en la pestaña Configuración se vuelven a aplicar al arrancar el servidor; cámbialas allí. Los cambios aquí se aplican al reiniciar.</p>
      )}
      {save.error && <p role="alert" className="text-sm text-red-400">{errText(save.error)}</p>}
      {file.isPending && <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Cargando…</div>}
      {file.isError && <p role="alert" className="text-sm text-red-400">{errText(file.error)}</p>}
      {file.data && (
        <CodeEditor
          initial={file.data.content}
          language={editorLanguage(name) ?? "text"}
          onView={(v) => { view.current = v; }}
          onChange={() => {
            const d = view.current ? !isClean(view.current.state.doc, saved.current ?? "") : true;
            setDirty(d);
            if (d && !inFlight.current) save.reset(); // nunca durante un PUT en vuelo
          }}
          onSave={doSave}
        />
      )}
    </div>
  );
}
