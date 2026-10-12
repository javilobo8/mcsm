import { describe, expect, it } from "vitest";
import { defaultSpecInput, type ImportCandidateDto, type ImportedFrom } from "@mcsm/shared";
import type { ObservedDto, ServerDto } from "./api";
import type { EditableSpec } from "./spec-edit";
import { adoptBlock, adoptRequest, candidateStateLabel, importNotices, initialReview, isAdopted, isPristine, reviewDirty, reviewLeaveWarning, serverImportView } from "./import";

const ID = "a".repeat(64);
const spec: EditableSpec = { ...defaultSpecInput(), type: "PAPER", version: "1.21.4", memory: "4G", env: { MOTD: "Hola" }, ports: { game: 25565, extra: [] } };
const cand = (over: Partial<ImportCandidateDto> = {}, proposal: Partial<ImportCandidateDto["proposal"]> = {}): ImportCandidateDto => ({
  containerId: ID, containerName: "survival", image: "itzg/minecraft-server:java21", state: "running", composeProject: "casa", composeService: "survival",
  blockers: [], warnings: [], hiddenEnv: ["RCON_PASSWORD"],
  proposal: { name: "survival", slug: "survival", slugLocked: false, desiredState: "running", spec, specError: null, dataPath: "/home/lobo/mc/survival", ...proposal },
  ...over,
});
const noErrors = { fieldErrors: {}, specError: null };

describe("revisión de un candidato", () => {
  it("empieza con la propuesta y sin cambios", () => {
    const c = cand();
    const r = initialReview(c);
    expect(r).toEqual({ name: "survival", slug: "survival", spec });
    expect(isPristine(c, r.spec)).toBe(true);
    expect(isPristine(c, { ...r.spec, memory: "6G" })).toBe(false);
    expect(isPristine(cand({}, { specError: "type: falta el modpack" }), r.spec)).toBe(false);
  });

  it("bloqueos en orden: candidato, nombre, slug, campos, spec y cambios sin aplicar", () => {
    const c = cand();
    const r = initialReview(c);
    expect(adoptBlock(cand({ blockers: ["Su /data es un volumen"] }), r, { ...noErrors, applyNow: false })).toBe("Su /data es un volumen");
    expect(adoptBlock(c, { ...r, name: "  " }, { ...noErrors, applyNow: false })).toMatch(/nombre/);
    expect(adoptBlock(c, { ...r, slug: "Mal" }, { ...noErrors, applyNow: false })).toMatch(/[Ss]lug/);
    expect(adoptBlock(c, r, { fieldErrors: { "sf-memory": "x" }, specError: null, applyNow: false })).toMatch(/1 campo/);
    expect(adoptBlock(c, r, { fieldErrors: {}, specError: "memory: inválida", applyNow: true })).toBe("memory: inválida");
    const changed = { ...r, spec: { ...r.spec, memory: "6G" } };
    expect(adoptBlock(c, changed, { ...noErrors, applyNow: false })).toMatch(/Adoptar y aplicar/);
    expect(adoptBlock(c, changed, { ...noErrors, applyNow: true })).toBeNull();
    expect(adoptBlock(c, r, { ...noErrors, applyNow: false })).toBeNull();
  });

  it("la petición no lleva dataPath, ni slug si está fijo", () => {
    const c = cand();
    const r = { ...initialReview(c), name: " Survival ", spec: { ...spec, dataPath: "/otra" } };
    expect(adoptRequest(c, r, false)).toEqual({ containerId: ID, name: "Survival", slug: "survival", spec, applyNow: false });
    expect(adoptRequest(cand({}, { slugLocked: true }), initialReview(c), true)).toEqual({ containerId: ID, name: "survival", spec, applyNow: true });
  });

  it("cambios sin guardar en la revisión: nombre, slug o spec distintos de la propuesta", () => {
    const c = cand();
    const r = initialReview(c);
    expect(reviewDirty(c, r)).toBe(false);
    expect(reviewDirty(c, { ...r, spec: { ...r.spec } })).toBe(false);
    expect(reviewDirty(c, { ...r, name: "Otro" })).toBe(true);
    expect(reviewDirty(c, { ...r, slug: "otro" })).toBe(true);
    expect(reviewDirty(c, { ...r, spec: { ...r.spec, memory: "6G" } })).toBe(true);
    expect(reviewLeaveWarning(false)).toBeNull();
    expect(reviewLeaveWarning(true)?.title).toBeTruthy();
  });

  it("estados en castellano", () => {
    expect(candidateStateLabel("running")).toBe("En marcha");
    expect(candidateStateLabel("exited")).toBe("Parado");
    expect(candidateStateLabel("raro")).toBe("raro");
  });
});

describe("avisos de un servidor importado", () => {
  const from: ImportedFrom = { containerId: ID, containerName: "survival", specVersion: 1, importedAt: "", composeProject: "casa", composeService: "survival" };
  const observed = (containerId: string) => ({ containerId } as ObservedDto);
  const server = (over: Partial<ServerDto>): Pick<ServerDto, "importedFrom" | "observed" | "slug" | "spec"> =>
    ({ slug: "survival", importedFrom: null, observed: null, spec: { ...spec, ports: { game: 25565, extra: [] } }, ...over } as ServerDto);

  it("adoptado: sigue en el original, se recreará y avisa de Compose y de dataPath", () => {
    const s = server({ importedFrom: from, observed: observed(ID), spec: { ...spec, ports: { game: 25565, extra: [] }, dataPath: "/home/lobo/mc/survival" } });
    expect(isAdopted(s)).toBe(true);
    const n = importNotices(s);
    expect(n).toHaveLength(3);
    expect(n[0]).toMatch(/mcsm-survival/);
    expect(n[1]).toMatch(/Compose/);
    expect(n[2]).toMatch(/\/home\/lobo\/mc\/survival/);
    expect(n[2]).toMatch(/migrar/);
  });

  it("ya recreado: solo el aviso de dataPath; un servidor normal no tiene avisos", () => {
    const s = server({ importedFrom: from, observed: observed("b".repeat(64)), spec: { ...spec, ports: { game: 25565, extra: [] }, dataPath: "/home/lobo/mc/survival" } });
    expect(isAdopted(s)).toBe(false);
    expect(importNotices(s)).toHaveLength(1);
    expect(importNotices(server({}))).toEqual([]);
  });
});

describe("serverImportView: pestañas y borrado de un servidor importado (I3, m5)", () => {
  const from: ImportedFrom = { containerId: ID, containerName: "mc-viejo", specVersion: 1, importedAt: "", composeProject: "casa", composeService: "survival" };
  const base = { slug: "survival", importedFrom: null, observed: null, spec: { ...spec, ports: { game: 25565, extra: [] } } } as unknown as ServerDto;
  const withData = { ...base, spec: { ...base.spec, dataPath: "/home/lobo/mc/survival" } } as ServerDto;

  it("un servidor del panel: todo disponible y el texto de borrado de siempre", () => {
    const v = serverImportView(base);
    expect(v).toMatchObject({ backups: null, files: null, deleteData: null, migrate: null });
    expect(v.deleteDescription).not.toMatch(/original/);
  });

  it("con dataPath: sin copias ni archivos, y la casilla de borrar el mundo desactivada, explicando por qué", () => {
    const v = serverImportView(withData);
    for (const why of [v.backups, v.files, v.deleteData]) expect(why).toMatch(/\/home\/lobo\/mc\/survival/);
    expect(v.backups).toMatch(/copias/);
    expect(v.files).toMatch(/archivos/);
    expect(v.backups).toMatch(/vuelve a importarlo/);
    expect(v.deleteData).toMatch(/no los borra/);
  });

  it("con dataPath: la pestaña Migrar explica por qué no se migra y cómo, en vez de acabar en un 409 (Planes 6 y 7)", () => {
    const v = serverImportView(withData);
    expect(v.migrate).toMatch(/\/home\/lobo\/mc\/survival/);
    expect(v.migrate).toMatch(/no se puede migrar/);
    expect(v.migrate).toMatch(/DATA_ROOT\/survival\/data/);
    expect(v.migrate).toMatch(/vuelve a importarlo/);
    expect(v.migrate).not.toMatch(/quita/);
  });

  it("aún adoptado: el borrado elimina el contenedor original que se importó (y avisa de Compose)", () => {
    const v = serverImportView({ ...base, importedFrom: from, observed: { containerId: ID } as ObservedDto });
    expect(v.deleteDescription).toMatch(/original «mc-viejo»/);
    expect(v.deleteDescription).toMatch(/Compose/);
    expect(v.backups).toBeNull(); // datos en DATA_ROOT: copias y archivos funcionan
  });

  it("estado desconocido (nodo sin observar): lo advierte por si aún es el original", () => {
    expect(serverImportView({ ...base, importedFrom: from }).deleteDescription).toMatch(/si aún no se ha recreado/i);
  });

  it("ya recreado como mcsm-<slug>: el texto de siempre", () => {
    expect(serverImportView({ ...base, importedFrom: from, observed: { containerId: "b".repeat(64) } as ObservedDto }).deleteDescription).not.toMatch(/original/);
  });
});
