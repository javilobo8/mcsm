import { describe, expect, it } from "vitest";
import { defaultSpecInput, type ImportCandidateDto, type ImportedFrom } from "@mcsm/shared";
import type { ObservedDto, ServerDto } from "./api";
import type { EditableSpec } from "./spec-edit";
import { adoptBlock, adoptRequest, candidateStateLabel, importNotices, initialReview, isAdopted, isPristine, reviewDirty, reviewLeaveWarning, serverImportView } from "./import";

const ID = "a".repeat(64);
const spec: EditableSpec = { ...defaultSpecInput(), type: "PAPER", version: "1.21.4", memory: "4G", env: { MOTD: "Hello" }, ports: { game: 25565, extra: [] } };
const cand = (over: Partial<ImportCandidateDto> = {}, proposal: Partial<ImportCandidateDto["proposal"]> = {}): ImportCandidateDto => ({
  containerId: ID, containerName: "survival", image: "itzg/minecraft-server:java21", state: "running", composeProject: "home", composeService: "survival",
  blockers: [], warnings: [], hiddenEnv: ["RCON_PASSWORD"],
  proposal: { name: "survival", slug: "survival", slugLocked: false, desiredState: "running", spec, specError: null, dataPath: "/home/lobo/mc/survival", ...proposal },
  ...over,
});
const noErrors = { fieldErrors: {}, specError: null };

describe("review of a candidate", () => {
  it("starts with the proposal and without changes", () => {
    const c = cand();
    const r = initialReview(c);
    expect(r).toEqual({ name: "survival", slug: "survival", spec });
    expect(isPristine(c, r.spec)).toBe(true);
    expect(isPristine(c, { ...r.spec, memory: "6G" })).toBe(false);
    expect(isPristine(cand({}, { specError: "type: the modpack is missing" }), r.spec)).toBe(false);
  });

  it("blocks in order: candidate, name, slug, fields, spec and unapplied changes", () => {
    const c = cand();
    const r = initialReview(c);
    expect(adoptBlock(cand({ blockers: ["Its /data is a volume"] }), r, { ...noErrors, applyNow: false })).toBe("Its /data is a volume");
    expect(adoptBlock(c, { ...r, name: "  " }, { ...noErrors, applyNow: false })).toMatch(/name/);
    expect(adoptBlock(c, { ...r, slug: "Bad" }, { ...noErrors, applyNow: false })).toMatch(/[Ss]lug/);
    expect(adoptBlock(c, r, { fieldErrors: { "sf-memory": "x" }, specError: null, applyNow: false })).toMatch(/1 field/);
    expect(adoptBlock(c, r, { fieldErrors: {}, specError: "memory: invalid", applyNow: true })).toBe("memory: invalid");
    const changed = { ...r, spec: { ...r.spec, memory: "6G" } };
    expect(adoptBlock(c, changed, { ...noErrors, applyNow: false })).toMatch(/Adopt and apply/);
    expect(adoptBlock(c, changed, { ...noErrors, applyNow: true })).toBeNull();
    expect(adoptBlock(c, r, { ...noErrors, applyNow: false })).toBeNull();
  });

  it("the request carries no dataPath, nor slug if it is fixed", () => {
    const c = cand();
    const r = { ...initialReview(c), name: " Survival ", spec: { ...spec, dataPath: "/other" } };
    expect(adoptRequest(c, r, false)).toEqual({ containerId: ID, name: "Survival", slug: "survival", spec, applyNow: false });
    expect(adoptRequest(cand({}, { slugLocked: true }), initialReview(c), true)).toEqual({ containerId: ID, name: "survival", spec, applyNow: true });
  });

  it("unsaved changes in the review: name, slug or spec different from the proposal", () => {
    const c = cand();
    const r = initialReview(c);
    expect(reviewDirty(c, r)).toBe(false);
    expect(reviewDirty(c, { ...r, spec: { ...r.spec } })).toBe(false);
    expect(reviewDirty(c, { ...r, name: "Other" })).toBe(true);
    expect(reviewDirty(c, { ...r, slug: "other" })).toBe(true);
    expect(reviewDirty(c, { ...r, spec: { ...r.spec, memory: "6G" } })).toBe(true);
    expect(reviewLeaveWarning(false)).toBeNull();
    expect(reviewLeaveWarning(true)?.title).toBeTruthy();
  });

  it("plan-8: the router is not adopted (it is enabled later, in Configuration → Network): it neither travels, nor makes it dirty, nor prevents adopting without stopping", () => {
    const c = cand();
    const r = initialReview(c);
    const routed = { ...r, spec: { ...r.spec, router: { enabled: true, hostname: "survival.lan" } } };
    expect(adoptRequest(c, routed, false)).toEqual({ containerId: ID, name: "survival", slug: "survival", spec, applyNow: false });
    expect(isPristine(c, routed.spec)).toBe(true);
    expect(reviewDirty(c, routed)).toBe(false);
    expect(adoptBlock(c, routed, { ...noErrors, applyNow: false })).toBeNull();
    // Also if the proposal brought it.
    const withRouter = cand({}, { spec: { ...spec, router: { enabled: true, hostname: "x.lan" } } });
    expect(adoptRequest(withRouter, initialReview(withRouter), true).spec).not.toHaveProperty("router");
    expect(isPristine(withRouter, spec)).toBe(true);
  });

  it("states in English", () => {
    expect(candidateStateLabel("running")).toBe("Running");
    expect(candidateStateLabel("exited")).toBe("Stopped");
    expect(candidateStateLabel("odd")).toBe("odd");
  });
});

describe("notices of an imported server", () => {
  const from: ImportedFrom = { containerId: ID, containerName: "survival", specVersion: 1, importedAt: "", composeProject: "home", composeService: "survival" };
  const observed = (containerId: string) => ({ containerId } as ObservedDto);
  const server = (over: Partial<ServerDto>): Pick<ServerDto, "importedFrom" | "observed" | "slug" | "spec"> =>
    ({ slug: "survival", importedFrom: null, observed: null, spec: { ...spec, ports: { game: 25565, extra: [] } }, ...over } as ServerDto);

  it("adopted: still in the original, it will be recreated and warns about Compose and dataPath", () => {
    const s = server({ importedFrom: from, observed: observed(ID), spec: { ...spec, ports: { game: 25565, extra: [] }, dataPath: "/home/lobo/mc/survival" } });
    expect(isAdopted(s)).toBe(true);
    const n = importNotices(s);
    expect(n).toHaveLength(3);
    expect(n[0]).toMatch(/mcsm-survival/);
    expect(n[1]).toMatch(/Compose/);
    expect(n[2]).toMatch(/\/home\/lobo\/mc\/survival/);
    expect(n[2]).toMatch(/migrated/);
  });

  it("already recreated: only the dataPath notice; a normal server has no notices", () => {
    const s = server({ importedFrom: from, observed: observed("b".repeat(64)), spec: { ...spec, ports: { game: 25565, extra: [] }, dataPath: "/home/lobo/mc/survival" } });
    expect(isAdopted(s)).toBe(false);
    expect(importNotices(s)).toHaveLength(1);
    expect(importNotices(server({}))).toEqual([]);
  });
});

describe("serverImportView: tabs and deletion of an imported server (I3, m5)", () => {
  const from: ImportedFrom = { containerId: ID, containerName: "mc-old", specVersion: 1, importedAt: "", composeProject: "home", composeService: "survival" };
  const base = { slug: "survival", importedFrom: null, observed: null, spec: { ...spec, ports: { game: 25565, extra: [] } } } as unknown as ServerDto;
  const withData = { ...base, spec: { ...base.spec, dataPath: "/home/lobo/mc/survival" } } as ServerDto;

  it("a panel server: everything available and the usual delete text", () => {
    const v = serverImportView(base);
    expect(v).toMatchObject({ backups: null, files: null, deleteData: null, migrate: null, retire: null });
    expect(v.deleteDescription).not.toMatch(/original/);
  });

  it("with dataPath: no backups or files, and the delete-world checkbox disabled, explaining why", () => {
    const v = serverImportView(withData);
    for (const why of [v.backups, v.files, v.deleteData]) expect(why).toMatch(/\/home\/lobo\/mc\/survival/);
    expect(v.backups).toMatch(/backups/);
    expect(v.files).toMatch(/file browser/);
    expect(v.backups).toMatch(/import it again/);
    expect(v.deleteData).toMatch(/does not delete it/);
  });

  it("with dataPath: the Migrate tab explains why it is not migrated and how, instead of ending in a 409 (Plans 6 and 7)", () => {
    const v = serverImportView(withData);
    expect(v.migrate).toMatch(/\/home\/lobo\/mc\/survival/);
    expect(v.migrate).toMatch(/cannot be migrated/);
    expect(v.migrate).toMatch(/DATA_ROOT\/survival\/data/);
    expect(v.migrate).toMatch(/import it again/);
    expect(v.migrate).not.toMatch(/remove/);
  });

  it("still adopted: deleting removes the original container that was imported (and warns about Compose)", () => {
    const v = serverImportView({ ...base, importedFrom: from, observed: { containerId: ID } as ObservedDto });
    expect(v.deleteDescription).toMatch(/original “mc-old”/);
    expect(v.deleteDescription).toMatch(/Compose/);
    expect(v.backups).toBeNull(); // data in DATA_ROOT: backups and files work
  });

  it("unknown state (node not observed): it warns in case it is still the original", () => {
    const v = serverImportView({ ...base, importedFrom: from });
    expect(v.deleteDescription).toMatch(/if it has not been recreated yet/i);
    expect(v.retire).toMatch(/if it has not been recreated yet/i);
    expect(v.retire).toMatch(/“mc-old”/);
  });

  it("already recreated as mcsm-<slug>: the usual text", () => {
    const v = serverImportView({ ...base, importedFrom: from, observed: { containerId: "b".repeat(64) } as ObservedDto });
    expect(v.deleteDescription).not.toMatch(/original/);
    expect(v.retire).toBeNull();
  });

  it("still adopted: migrating it removes on the source the original container that was imported (and warns about Compose)", () => {
    const v = serverImportView({ ...base, importedFrom: from, observed: { containerId: ID } as ObservedDto });
    expect(v.retire).toMatch(/original container “mc-old”/);
    expect(v.retire).toMatch(/will be deleted/);
    expect(v.retire).toMatch(/Compose/);
    expect(v.retire).toMatch(/“home”/);
    const noCompose = serverImportView({ ...base, importedFrom: { ...from, composeProject: "", composeService: "" }, observed: { containerId: ID } as ObservedDto });
    expect(noCompose.retire).toMatch(/original container “mc-old”/);
    expect(noCompose.retire).not.toMatch(/Compose/);
  });
});
