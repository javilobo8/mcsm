import { describe, expect, it, vi } from "vitest";
import { dialogSubmit } from "./dialog-form";

describe("dialogSubmit", () => {
  it("evita el submit nativo, corta la propagación por el árbol de React y ejecuta la acción", () => {
    const action = vi.fn();
    const e = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
    dialogSubmit(action)(e);
    expect(e.preventDefault).toHaveBeenCalledOnce();
    expect(e.stopPropagation).toHaveBeenCalledOnce();
    expect(action).toHaveBeenCalledOnce();
  });
});

/** Etiquetas `<form …>` que aparecen entre `<DialogContent` y `</DialogContent>` en el código fuente. */
function formsInsideDialogs(src: string): string[] {
  const out: string[] = [];
  for (const block of src.match(/<DialogContent\b[\s\S]*?<\/DialogContent>/g) ?? []) out.push(...(block.match(/<form\b[^>]*>/g) ?? []));
  return out;
}

// Un Dialog de Radix se pinta en un portal, pero los eventos sintéticos de React suben por el árbol de
// componentes: el submit de un <form> del diálogo llega también al <form> que lo contiene (configuración,
// editor de plantillas). Regla: todo <form> dentro de un DialogContent usa onSubmit={dialogSubmit(…)}.
describe("formularios dentro de diálogos", () => {
  const sources = import.meta.glob<string>(["../**/*.tsx", "!../components/ui/**"], { query: "?raw", import: "default", eager: true });
  const files = Object.entries(sources).map(([f, src]) => [f, formsInsideDialogs(src)] as const).filter(([, forms]) => forms.length > 0);

  it("encuentra los diálogos con formulario", () => {
    expect(files.map(([f]) => f)).toEqual(expect.arrayContaining([
      "../components/spec-form/curseforge-key.tsx", "../components/save-template-dialog.tsx", "../routes/nodes.tsx",
      "../components/files/name-dialog.tsx",
    ]));
  });
  it("formsInsideDialogs ignora el <form> exterior que contiene al diálogo", () => {
    expect(formsInsideDialogs(`<form onSubmit={submit}><Dialog><DialogContent><Button /></DialogContent></Dialog></form>`)).toEqual([]);
    expect(formsInsideDialogs(`<DialogContent>\n<form\n  onSubmit={x}>`.concat("</form></DialogContent>"))).toHaveLength(1);
  });
  it.each(files)("%s: cada <form> de un diálogo usa onSubmit={dialogSubmit(…)}", (_f, forms) => {
    for (const tag of forms) expect(tag).toMatch(/onSubmit=\{dialogSubmit\(/);
  });
});
