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

const errText = (e: unknown) => (e instanceof ApiError ? e.message : "Unexpected error");

/** Editor for a text file (≤ 2 MiB). Saves with the button or Ctrl/Cmd+S. */
export function FileEditor({ serverId, path, onClose, onDirtyChange }: { serverId: string; path: string; onClose(): void; onDirtyChange?(dirty: boolean): void }) {
  const file = useQuery({ queryKey: ["file-content", serverId, path], queryFn: () => filesApi.read(serverId, path), gcTime: 0, staleTime: Infinity });
  const view = useRef<EditorView | null>(null);
  const [dirty, setDirty] = useState(false);
  // Last known content on disk (what was loaded, or what was last saved successfully).
  const saved = useRef<string | null>(null);
  if (saved.current === null && file.data) saved.current = file.data.content;
  const inFlight = useRef(false);
  const save = useMutation({
    mutationFn: (content: string) => filesApi.write(serverId, path, content),
    onSettled: () => { inFlight.current = false; },
    onSuccess: (_, content) => {
      saved.current = content;
      // If something was typed while the save was in flight, it stays dirty.
      setDirty(view.current ? !isClean(view.current.state.doc, content) : false);
    },
  });
  const doSave = () => {
    if (!view.current || !canStartSave({ hasView: true, dirty, inFlight: inFlight.current })) return;
    inFlight.current = true;
    save.mutate(view.current.state.doc.toString());
  };
  // The parent decides whether to close with unsaved changes (own dialog, not window.confirm).
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
          {dirty && <span className="text-warn">· unsaved</span>}
          {!dirty && save.isSuccess && <span className="text-ok">· saved</span>}
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" disabled={!dirty || save.isPending || !file.data} onClick={doSave}>{save.isPending ? <Loader2 className="animate-spin" /> : <Save />} Save</Button>
          <Button size="sm" variant="ghost" onClick={onClose}><X /> Close</Button>
        </div>
      </div>
      {name === "server.properties" && (
        <p className="text-sm text-muted-foreground">The properties defined in the Configuration tab are applied again when the server starts; change them there. Changes made here take effect on restart.</p>
      )}
      {save.error && <p role="alert" className="text-sm text-bad">{errText(save.error)}</p>}
      {file.isPending && <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading…</div>}
      {file.isError && <p role="alert" className="text-sm text-bad">{errText(file.error)}</p>}
      {file.data && (
        <CodeEditor
          initial={file.data.content}
          language={editorLanguage(name) ?? "text"}
          onView={(v) => { view.current = v; }}
          onChange={() => {
            const d = view.current ? !isClean(view.current.state.doc, saved.current ?? "") : true;
            setDirty(d);
            if (d && !inFlight.current) save.reset(); // never during an in-flight PUT
          }}
          onSave={doSave}
        />
      )}
    </div>
  );
}
