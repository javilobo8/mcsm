import { describe, expect, it } from "vitest";
import src from "./server.tsx?raw";

/** Bloques `<TabsContent value="…">…</TabsContent>` del código fuente, por valor. */
function tabContents(code: string): [string, string][] {
  return [...code.matchAll(/<TabsContent\s+value="([^"]+)"[\s\S]*?<\/TabsContent>/g)].map((m) => [m[1]!, m[0]]);
}

// Al pasar de un servidor a otro la página no se desmonta: sin key, el contenido de una pestaña
// arrastraría su estado (ediciones sin guardar, mutaciones, rango de las gráficas) al otro servidor.
describe("pestañas del servidor", () => {
  const tabs = tabContents(src);

  it("encuentra todas las pestañas", () => {
    expect(tabs.map(([v]) => v)).toEqual(["overview", "console", "config", "backups", "history", "files"]);
  });
  it.each(tabs)("%s: su contenido con estado lleva key={s.id}", (_v, block) => {
    expect(block).toContain("key={s.id}");
  });
});
