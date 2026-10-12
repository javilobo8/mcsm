import { describe, expect, it } from "vitest";
import { specSchema } from "@mcsm/shared";
import { proposeTarget, requiredSpace, retargetFilename, uniqueSlugAmong } from "./propose.js";

const spec = (game: number, extra: { host: number; container: number; proto: "tcp" | "udp"; label?: string }[] = []) =>
  specSchema.parse({ type: "PAPER", version: "1.21.4", memory: "2G", ports: { game, extra }, rconPassword: "abcdefgh" });
const range = { from: 25565, to: 25570 };

describe("proposeTarget", () => {
  it("conserva slug y puerto si están libres en el destino", () => {
    expect(proposeTarget({ slug: "survival", spec: spec(25570), targetServers: [], range }))
      .toEqual({ ok: true, slug: "survival", port: 25570, portChanged: false });
  });
  it("puerto ocupado: el primero libre del rango que no sea un puerto extra del propio servidor", () => {
    const p = proposeTarget({
      slug: "survival", spec: spec(25565, [{ host: 25566, container: 19132, proto: "udp" }]),
      targetServers: [{ slug: "otro", spec: spec(25565) }], range,
    });
    expect(p).toEqual({ ok: true, slug: "survival", port: 25567, portChanged: true });
  });
  it("slug reservado (origen con la retirada pendiente): también se evita", () => {
    const p = proposeTarget({ slug: "survival", spec: spec(25570), targetServers: [], reservedSlugs: ["survival"], range });
    expect(p).toMatchObject({ ok: true, slug: "survival-2", port: 25570, portChanged: false });
  });
  it("slug ocupado: sufijo -2", () => {
    const p = proposeTarget({ slug: "survival", spec: spec(25570), targetServers: [{ slug: "survival", spec: spec(25565) }], range });
    expect(p).toMatchObject({ ok: true, slug: "survival-2", port: 25570 });
  });
  it("puerto pedido: se usa si está libre (aunque esté fuera del rango) y si no, error", () => {
    expect(proposeTarget({ slug: "s", spec: spec(25565), targetServers: [], range, requestedPort: 30000 }))
      .toEqual({ ok: true, slug: "s", port: 30000, portChanged: true });
    const p = proposeTarget({ slug: "s", spec: spec(25565), targetServers: [{ slug: "o", spec: spec(25568) }], range, requestedPort: 25568 });
    expect(p).toEqual({ ok: false, error: "El puerto 25568 ya está en uso en el nodo destino" });
  });
  it("un puerto extra que choca en el destino no se cambia solo: error", () => {
    const p = proposeTarget({
      slug: "s", spec: spec(25565, [{ host: 19132, container: 19132, proto: "udp", label: "Geyser" }]),
      targetServers: [{ slug: "o", spec: spec(25566, [{ host: 19132, container: 19132, proto: "udp" }]) }], range,
    });
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.error).toMatch(/19132 \(Geyser\)/);
  });
  it("sin puertos libres en el rango: error", () => {
    const full = [25565, 25566, 25567, 25568, 25569, 25570].map((g, i) => ({ slug: `o${i}`, spec: spec(g) }));
    expect(proposeTarget({ slug: "s", spec: spec(25565), targetServers: full, range }).ok).toBe(false);
  });
});

describe("utilidades", () => {
  it("uniqueSlugAmong respeta los 40 caracteres", () => {
    expect(uniqueSlugAmong("a", new Set(["a", "a-2"]))).toBe("a-3");
    const long = "x".repeat(40);
    expect(uniqueSlugAmong(long, new Set([long]))).toBe(`${"x".repeat(38)}-2`);
  });
  it("retargetFilename cambia solo el slug", () => {
    expect(retargetFilename("survival-20261012T040000.000Z-3.tar.zst", "survival", "survival-2")).toBe("survival-2-20261012T040000.000Z-3.tar.zst");
    expect(() => retargetFilename("otro-20261012T040000.000Z-3.tar.zst", "survival", "x")).toThrow();
  });
  it("requiredSpace: el mayor de 5 % y 256 MiB de margen", () => {
    expect(requiredSpace(0)).toBe(256 * 1024 * 1024);
    expect(requiredSpace(100 * 1024 ** 3)).toBe(105 * 1024 ** 3);
  });
});
