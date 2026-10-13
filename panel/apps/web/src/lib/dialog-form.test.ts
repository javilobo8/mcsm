import { describe, expect, it, vi } from "vitest";
import { dialogSubmit } from "./dialog-form";

describe("dialogSubmit", () => {
  it("prevents the native submit, stops propagation through the React tree and runs the action", () => {
    const action = vi.fn();
    const e = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
    dialogSubmit(action)(e);
    expect(e.preventDefault).toHaveBeenCalledOnce();
    expect(e.stopPropagation).toHaveBeenCalledOnce();
    expect(action).toHaveBeenCalledOnce();
  });
});

/** `<form …>` tags that appear between `<DialogContent` and `</DialogContent>` in the source code. */
function formsInsideDialogs(src: string): string[] {
  const out: string[] = [];
  for (const block of src.match(/<DialogContent\b[\s\S]*?<\/DialogContent>/g) ?? []) out.push(...(block.match(/<form\b[^>]*>/g) ?? []));
  return out;
}

// A Radix Dialog is rendered in a portal, but React's synthetic events bubble up the component
// tree: the submit of a dialog's <form> also reaches the <form> that contains it (configuration,
// template editor). Rule: every <form> inside a DialogContent uses onSubmit={dialogSubmit(…)}.
describe("forms inside dialogs", () => {
  const sources = import.meta.glob<string>(["../**/*.tsx", "!../components/ui/**"], { query: "?raw", import: "default", eager: true });
  const files = Object.entries(sources).map(([f, src]) => [f, formsInsideDialogs(src)] as const).filter(([, forms]) => forms.length > 0);

  it("finds the dialogs with a form", () => {
    expect(files.map(([f]) => f)).toEqual(expect.arrayContaining([
      "../components/spec-form/curseforge-key.tsx", "../components/save-template-dialog.tsx", "../routes/nodes.tsx",
      "../components/files/name-dialog.tsx",
    ]));
  });
  it("formsInsideDialogs ignores the outer <form> that contains the dialog", () => {
    expect(formsInsideDialogs(`<form onSubmit={submit}><Dialog><DialogContent><Button /></DialogContent></Dialog></form>`)).toEqual([]);
    expect(formsInsideDialogs(`<DialogContent>\n<form\n  onSubmit={x}>`.concat("</form></DialogContent>"))).toHaveLength(1);
  });
  it.each(files)("%s: every <form> of a dialog uses onSubmit={dialogSubmit(…)}", (_f, forms) => {
    for (const tag of forms) expect(tag).toMatch(/onSubmit=\{dialogSubmit\(/);
  });
});
