import { useEffect, useLayoutEffect, useRef } from "react";
import { EditorView, basicSetup } from "codemirror";
import { EditorState, Prec, type Extension } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { StreamLanguage } from "@codemirror/language";
import { json } from "@codemirror/lang-json";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { yaml } from "@codemirror/legacy-modes/mode/yaml";
import { oneDark } from "@codemirror/theme-one-dark";
import type { EditorLanguage } from "@mcsm/shared";

function languageExtension(lang: EditorLanguage): Extension {
  switch (lang) {
    case "json": return json();
    case "yaml": return StreamLanguage.define(yaml);
    case "toml": return StreamLanguage.define(toml);
    case "properties": return StreamLanguage.define(properties);
    case "text": return [];
  }
}

interface Props {
  initial: string;
  language: EditorLanguage;
  /** Receives the view on mount (and null on unmount) to read the document when saving. */
  onView(view: EditorView | null): void;
  /** Called after every document change; reads the content from the view received in onView. */
  onChange(): void;
  onSave(): void;
}

/**
 * CodeMirror 6 without React dependencies: created on mount and destroyed on unmount.
 * `initial` and `language` only apply on mount: a later change does NOT recreate the view nor
 * overwrite what was edited. To load other content/language, remount the component with `key`.
 */
export function CodeEditor({ initial, language, onView, onChange, onSave }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const cb = useRef({ onView, onChange, onSave });
  useLayoutEffect(() => { cb.current = { onView, onChange, onSave }; });

  useEffect(() => {
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: initial,
        extensions: [
          basicSetup,
          oneDark,
          languageExtension(language),
          Prec.highest(keymap.of([{ key: "Mod-s", preventDefault: true, run: () => { cb.current.onSave(); return true; } }])),
          EditorView.updateListener.of((u) => { if (u.docChanged) cb.current.onChange(); }),
          EditorView.theme({ "&": { height: "65vh", fontSize: "12px" }, ".cm-scroller": { fontFamily: "ui-monospace, SFMono-Regular, monospace" } }),
        ],
      }),
    });
    cb.current.onView(view);
    return () => { cb.current.onView(null); view.destroy(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on mount (see the component's doc)
  }, []);

  return <div ref={host} className="overflow-hidden rounded-md border border-border" />;
}
