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
});
