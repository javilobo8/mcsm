import { useEffect, useLayoutEffect, useRef } from "react";
import { EditorView, basicSetup } from "codemirror";
import { EditorState, Prec, type Extension } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { json } from "@codemirror/lang-json";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { yaml } from "@codemirror/legacy-modes/mode/yaml";
import { oneDarkHighlightStyle } from "@codemirror/theme-one-dark";
import type { EditorLanguage } from "@mcsm/shared";

/** One Dark's syntax colours on the panel's palette (index.css): obsidian page, cobble gutter, grass cursor. */
const panelTheme = EditorView.theme({
  "&": { height: "65vh", fontSize: "12px", color: "#d5dae0", backgroundColor: "var(--obsidian)" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.65" },
  ".cm-content": { caretColor: "var(--grass)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--grass)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "color-mix(in srgb, var(--grass) 28%, transparent)",
  },
  ".cm-gutters": { backgroundColor: "var(--bedrock)", color: "var(--fog)", border: "none", borderRight: "1px solid var(--cobble)" },
  ".cm-activeLine": { backgroundColor: "rgb(255 255 255 / 0.03)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--bedrock-2)", color: "var(--bone)" },
  ".cm-searchMatch": { backgroundColor: "color-mix(in srgb, var(--torch) 25%, transparent)", outline: "1px solid color-mix(in srgb, var(--torch) 50%, transparent)" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "color-mix(in srgb, var(--torch) 40%, transparent)" },
  ".cm-selectionMatch": { backgroundColor: "rgb(255 255 255 / 0.07)" },
  "&.cm-focused .cm-matchingBracket": { backgroundColor: "color-mix(in srgb, var(--grass) 22%, transparent)" },
  ".cm-foldPlaceholder": { backgroundColor: "transparent", border: "none", color: "var(--fog)" },
  ".cm-tooltip": { border: "1px solid var(--cobble-2)", backgroundColor: "var(--bedrock)" },
  ".cm-panels": { backgroundColor: "var(--bedrock)", color: "var(--bone)" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--cobble)" },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--cobble)" },
}, { dark: true });

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
          panelTheme,
          syntaxHighlighting(oneDarkHighlightStyle),
          languageExtension(language),
          Prec.highest(keymap.of([{ key: "Mod-s", preventDefault: true, run: () => { cb.current.onSave(); return true; } }])),
          EditorView.updateListener.of((u) => { if (u.docChanged) cb.current.onChange(); }),
        ],
      }),
    });
    cb.current.onView(view);
    return () => { cb.current.onView(null); view.destroy(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on mount (see the component's doc)
  }, []);

  return <div ref={host} className="overflow-hidden rounded-lg border border-cobble" />;
}
