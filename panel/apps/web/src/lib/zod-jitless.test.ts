import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

describe("zod sin JIT (CSP script-src 'self')", () => {
  it("construir y validar esquemas no prueba `new Function` (la CSP lo notificaría como violación)", async () => {
    let probes = 0;
    const Real = Function;
    vi.stubGlobal("Function", new Proxy(Real, { construct(target, args, newTarget) { probes++; return Reflect.construct(target, args, newTarget); } }));
    try {
      await import("./zod-jitless");
      const { z } = await import("zod");
      expect(z.object({ a: z.string() }).safeParse({ a: "x" }).success).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(probes).toBe(0);
  });

  it("main.tsx lo importa antes que nada (los esquemas de @mcsm/shared se construyen al cargarse)", () => {
    const src = readFileSync(new URL("../main.tsx", import.meta.url), "utf8");
    const firstImport = src.split("\n").find((l) => l.startsWith("import "));
    expect(firstImport).toBe('import "./lib/zod-jitless";');
  });
});
