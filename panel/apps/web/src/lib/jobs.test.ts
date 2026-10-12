import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { applyJobEvent, capLog, MAX_JOB_LOG, backupsKey, bindJobsLive, jobKey, jobsKey, jobTriggerLabel, jobsFilterFor, JOB_FILTER_OPTIONS, formatFinishTime, retainJobsLive, upsertJob, type JobsLiveSource } from "./jobs";
import { topicOf } from "./ws";
import type { JobDetailDto, JobDto, ServerMessage } from "./api";

const job = (id: string, createdAt: string, over: Partial<JobDto> = {}): JobDto => ({
  id, type: "backup", serverId: "s1", nodeId: "n1", status: "running", progress: 0, message: "", payload: {},
  createdAt, updatedAt: createdAt, startedAt: createdAt, finishedAt: null, ...over,
});
const all = { serverId: null, status: null };

function fakeLive() {
  const handlers = new Map<string, (m: ServerMessage) => void>();
  const reconnect: (() => void)[] = [];
  const subscribe = vi.fn((topic: string, h: (m: ServerMessage) => void) => { handlers.set(topic, h); return () => handlers.delete(topic); });
  const live: JobsLiveSource = { subscribe, onReconnect: (cb) => { reconnect.push(cb); return () => {}; } };
  return { live, subscribe, emit: (m: ServerMessage) => handlers.get("jobs")?.(m), reconnect: () => reconnect.forEach((cb) => cb()), handlers };
}

describe("upsertJob", () => {
  const a = job("a", "2026-10-12T04:00:00.000Z");
  const b = job("b", "2026-10-12T05:00:00.000Z");
  it("inserta un job nuevo en orden (más nuevos primero)", () => {
    expect(upsertJob([a], b, all).map((j) => j.id)).toEqual(["b", "a"]);
  });
  it("sustituye el existente", () => {
    expect(upsertJob([b, a], { ...a, progress: 50 }, all).find((j) => j.id === "a")!.progress).toBe(50);
  });
  it("lo quita cuando deja de cumplir el filtro y no toca listas de otro servidor", () => {
    expect(upsertJob([b, a], { ...a, status: "ok" }, { serverId: null, status: "running" }).map((j) => j.id)).toEqual(["b"]);
    const other = [job("x", "2026-10-12T03:00:00.000Z", { serverId: "s2" })];
    expect(upsertJob(other, a, { serverId: "s2", status: null })).toBe(other);
  });
  it("ignora actualizaciones tras el estado terminal y eventos más viejos", () => {
    const done = job("a", "2026-10-12T04:00:00.000Z", { status: "ok", progress: 100, updatedAt: "2026-10-12T04:05:00.000Z" });
    const list = [done];
    expect(upsertJob(list, { ...a, progress: 30, updatedAt: "2026-10-12T04:06:00.000Z" }, all)).toBe(list);
    const fresh = [job("a", "2026-10-12T04:00:00.000Z", { progress: 60, updatedAt: "2026-10-12T04:03:00.000Z" })];
    expect(upsertJob(fresh, { ...a, progress: 10, updatedAt: "2026-10-12T04:01:00.000Z" }, all)).toBe(fresh);
  });
});

describe("applyJobEvent", () => {
  it("actualiza las listas en caché y añade el trozo de log al detalle", () => {
    const qc = new QueryClient();
    const a = job("a", "2026-10-12T04:00:00.000Z");
    qc.setQueryData(jobsKey({ serverId: "s1" }), [a]);
    qc.setQueryData(jobsKey({ status: "running" }), [a]);
    qc.setQueryData<JobDetailDto>(jobKey("a"), { ...a, log: "save-off\n" });
    applyJobEvent(qc, { type: "job", job: { ...a, progress: 40 }, logChunk: "save-all flush\n" });
    expect(qc.getQueryData<JobDto[]>(jobsKey({ serverId: "s1" }))![0]!.progress).toBe(40);
    expect(qc.getQueryData<JobDetailDto>(jobKey("a"))!.log).toBe("save-off\nsave-all flush\n");
  });
  it("no añade log ni estado a un detalle ya terminal", () => {
    const qc = new QueryClient();
    const done = job("a", "2026-10-12T04:00:00.000Z", { status: "failed", updatedAt: "2026-10-12T04:05:00.000Z" });
    qc.setQueryData<JobDetailDto>(jobKey("a"), { ...done, log: "fin\n" });
    applyJobEvent(qc, { type: "job", job: { ...done, status: "running", updatedAt: "2026-10-12T04:06:00.000Z" }, logChunk: "tarde\n" });
    const d = qc.getQueryData<JobDetailDto>(jobKey("a"))!;
    expect(d.log).toBe("fin\n");
    expect(d.status).toBe("failed");
  });
  it("sin datos en caché no crea ni cancela nada", () => {
    const qc = new QueryClient();
    applyJobEvent(qc, { type: "job", job: job("a", "2026-10-12T04:00:00.000Z"), logChunk: "x" });
    expect(qc.getQueryData(jobKey("a"))).toBeUndefined();
  });
  it("un log completo reemplaza al acumulado y se acota como en el panel", () => {
    const qc = new QueryClient();
    const a = job("a", "2026-10-12T04:00:00.000Z");
    qc.setQueryData<JobDetailDto>(jobKey("a"), { ...a, log: "viejo\n" });
    applyJobEvent(qc, { type: "job", job: a, logChunk: "", log: "nuevo\n" });
    expect(qc.getQueryData<JobDetailDto>(jobKey("a"))!.log).toBe("nuevo\n");
    const big = capLog("x".repeat(MAX_JOB_LOG + 10));
    expect(big.length).toBe(MAX_JOB_LOG);
    expect(big.startsWith("…(recortado)\n")).toBe(true);
  });
  it("no cancela refetch de listas a las que el evento no afecta ni del detalle terminal", () => {
    const qc = new QueryClient();
    const cancel = vi.spyOn(qc, "cancelQueries");
    const other = job("x", "2026-10-12T03:00:00.000Z", { serverId: "s2" });
    qc.setQueryData(jobsKey({ serverId: "s2" }), [other]);
    const done = job("a", "2026-10-12T04:00:00.000Z", { status: "ok", updatedAt: "2026-10-12T04:05:00.000Z" });
    qc.setQueryData<JobDetailDto>(jobKey("a"), { ...done, log: "fin\n" });
    vi.spyOn(qc, "isFetching").mockReturnValue(1);
    applyJobEvent(qc, { type: "job", job: { ...done, status: "running", updatedAt: "2026-10-12T04:06:00.000Z" }, logChunk: "t" });
    expect(cancel).not.toHaveBeenCalled();
  });
  it("al terminar un job recarga las copias de su servidor y su detalle", () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    applyJobEvent(qc, { type: "job", job: job("a", "2026-10-12T04:00:00.000Z", { status: "ok" }), logChunk: "" });
    expect(spy).toHaveBeenCalledWith({ queryKey: backupsKey("s1") });
    expect(spy).toHaveBeenCalledWith({ queryKey: jobKey("a") });
  });
});

describe("bindJobsLive / retainJobsLive", () => {
  it("un aviso de copias recarga la lista de ese servidor; al reconectar recarga todo", () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    const f = fakeLive();
    const off = bindJobsLive(qc, f.live);
    f.emit({ type: "backups", serverId: "s1" });
    expect(spy).toHaveBeenCalledWith({ queryKey: backupsKey("s1") });
    f.reconnect();
    expect(spy).toHaveBeenCalledWith({ queryKey: ["jobs"] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["backups"] });
    off();
    expect(f.handlers.has("jobs")).toBe(false);
  });
  it("varias vistas comparten una sola suscripción", () => {
    const qc = new QueryClient();
    const f = fakeLive();
    const r1 = retainJobsLive(qc, f.live);
    const r2 = retainJobsLive(qc, f.live);
    expect(f.subscribe).toHaveBeenCalledTimes(1);
    r1();
    r1(); // liberar dos veces no cuenta doble
    expect(f.handlers.has("jobs")).toBe(true);
    r2();
    expect(f.handlers.has("jobs")).toBe(false);
  });
});

describe("jobTriggerLabel", () => {
  it("traduce el origen de la copia", () => {
    expect(jobTriggerLabel({ payload: { trigger: "scheduled" } })).toBe("Programada");
    expect(jobTriggerLabel({ payload: {} })).toBeNull();
    expect(jobTriggerLabel({ payload: { trigger: "raro" } })).toBeNull();
  });
});

describe("topicOf", () => {
  it("enruta job y backups al topic jobs", () => {
    expect(topicOf({ type: "backups", serverId: "s1" })).toBe("jobs");
    expect(topicOf({ type: "job", job: job("a", "2026-10-12T04:00:00.000Z"), logChunk: "" })).toBe("jobs");
  });
});

describe("jobsFilterFor", () => {
  it("Todos no filtra y el resto filtra por estado", () => {
    expect(jobsFilterFor(null)).toEqual({});
    expect(jobsFilterFor("failed")).toEqual({ status: "failed" });
  });
  it("ofrece Todos, En curso, Correctos y Fallidos, en ese orden", () => {
    expect(JOB_FILTER_OPTIONS.map((o) => [o.label, o.value])).toEqual([
      ["Todos", null], ["En curso", "running"], ["Correctos", "ok"], ["Fallidos", "failed"],
    ]);
  });
});

describe("formatFinishTime", () => {
  it("devuelve null sin fecha o con fecha inválida", () => {
    expect(formatFinishTime(null)).toBeNull();
    expect(formatFinishTime("basura")).toBeNull();
  });
  it("formatea la hora de una fecha válida", () => {
    expect(formatFinishTime("2026-10-12T10:05:07Z")).toMatch(/\d{1,2}:\d{2}:\d{2}/);
  });
});
