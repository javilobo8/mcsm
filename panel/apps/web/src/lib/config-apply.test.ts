import { describe, expect, it } from "vitest";
import { defaultSpecInput } from "@mcsm/shared";
import { planApply } from "./config-apply";

const base = { ...defaultSpecInput(), ports: { game: 25565, extra: [] } };

describe("planApply", () => {
  it("sin cambios devuelve error", () => {
    expect(planApply("A", base, "A", base)).toEqual({ ok: false, error: "No hay cambios que aplicar" });
  });
  it("solo nombre: sin spec y sin recreación", () => {
    const r = planApply("A", base, " B ", base);
    expect(r).toMatchObject({ ok: true, pending: { name: "B", spec: undefined, recreate: false } });
    if (r.ok) expect(r.pending.changes).toEqual([{ label: "Nombre", before: "A", after: "B" }]);
  });
  it("nombre vacío es error", () => {
    expect(planApply("A", base, "  ", base)).toEqual({ ok: false, error: "El nombre no puede estar vacío" });
  });
  it("spec: PATCH mínimo, diff y recreación; no manda ports si no cambian", () => {
    const r = planApply("A", base, "A", { ...base, memory: "6G" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pending.spec).toEqual({ memory: "6G" });
    expect(r.pending.recreate).toBe(true);
    expect(r.pending.changes.map((c) => c.label)).toEqual(["Memoria JVM"]);
  });
  it("quitar una sección opcional envía null; las obligatorias nunca", () => {
    const withOps = { ...base, ops: ["Lobo"] };
    const { ops: _o, ...without } = withOps;
    const r = planApply("A", withOps, "A", without as typeof base);
    expect(r.ok && r.pending.spec).toEqual({ ops: null });
  });
  it("puerto de juego vacío al editar = se conserva: ni diff «N → —» ni PATCH de ports", () => {
    const edited = { ...base, ports: { extra: [] } };
    expect(planApply("A", base, "A", edited)).toEqual({ ok: false, error: "No hay cambios que aplicar" });
    const withExtra = { ...base, ports: { extra: [{ host: 19132, container: 19132, proto: "udp" as const, label: "" }] } };
    const r = planApply("A", base, "A", withExtra);
    expect(r.ok && r.pending.spec).toEqual({ ports: { game: 25565, extra: withExtra.ports.extra } });
    expect(r.ok && r.pending.changes.map((c) => c.label)).toEqual(["Puertos extra"]);
  });
  it("activar la whitelist con la lista vacía avisa en el diff", () => {
    const r = planApply("A", base, "A", { ...base, whitelist: { enabled: true, players: [] } });
    expect(r.ok && r.pending.changes).toEqual([{ label: "Whitelist", before: "(sin gestionar)", after: expect.stringMatching(/nadie podrá entrar salvo los ops/) }]);
  });
});
