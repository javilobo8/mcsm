import { describe, expect, it } from "vitest";
import src from "./server.tsx?raw";

/** `<TabsContent value="…">…</TabsContent>` blocks in the source code, by value. */
function tabContents(code: string): [string, string][] {
  return [...code.matchAll(/<TabsContent\s+value="([^"]+)"[\s\S]*?<\/TabsContent>/g)].map((m) => [m[1]!, m[0]]);
}

// When going from one server to another the page does not unmount: without a key, a tab's content
// would carry its state (unsaved edits, mutations, chart range) over to the other server.
describe("server tabs", () => {
  const tabs = tabContents(src);

  it("finds all the tabs", () => {
    expect(tabs.map(([v]) => v)).toEqual(["overview", "console", "config", "backups", "history", "files", "migrate"]);
  });
  it.each(tabs)("%s: its stateful content carries key={s.id}", (_v, block) => {
    expect(block).toContain("key={s.id}");
  });
});
