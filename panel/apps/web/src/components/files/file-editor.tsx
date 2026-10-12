import { useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2, Save, X } from "lucide-react";
import type { EditorView } from "codemirror";
import { baseName, editorLanguage } from "@mcsm/shared";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { filesApi } from "@/lib/files";
import { CodeEditor } from "./code-editor";

const errText = (e: unknown) => (e instanceof ApiError ? e.message : "Error inesperado");

/** Editor de un fichero de texto (≤ 2 MiB). Guarda con el botón o Ctrl/Cmd+S. */
export function FileEditor({ serverId, path, onClose }: { serverId: string; path: string; onClose(): void }) {
  const file = useQuery({ queryKey: ["file-content", serverId, path], queryFn: () => filesApi.read(serverId, path), gcTime: 0, staleTime: Infinity });
  const view = useRef<EditorView | null>(null);
  const [dirty, setDirty] = useState(false);
  const save = useMutation({
    mutationFn: (content: string) => filesApi.write(serverId, path, content),
    onSuccess: () => setDirty(false),
  });
  const doSave = () => { if (view.current && !save.isPending) save.mutate(view.current.state.doc.toString()); };
  const close = () => { if (!dirty || confirm("Hay cambios sin guardar. ¿Descartarlos?")) onClose(); };
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
          <Button size="sm" variant="ghost" onClick={close}><X /> Cerrar</Button>
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
          onDirty={() => { setDirty(true); save.reset(); }}
          onSave={doSave}
        />
      )}
    </div>
  );
}
