import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { applyJobEvent, capLog, MAX_JOB_LOG, backupsKey, bindJobsLive, jobKey, jobsKey, jobTriggerLabel, jobsFilterFor, JOB_FILTER_OPTIONS, formatFinishTime, jobServerName, openRowId, retainJobsLive, upsertJob, withOpenRow, type JobsLiveSource } from "./jobs";
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
  it("inserts a new job in order (newest first)", () => {
    expect(upsertJob([a], b, all).map((j) => j.id)).toEqual(["b", "a"]);
  });
  it("replaces the existing one", () => {
    expect(upsertJob([b, a], { ...a, progress: 50 }, all).find((j) => j.id === "a")!.progress).toBe(50);
  });
  it("removes it when it stops matching the filter and does not touch another server's lists", () => {
    expect(upsertJob([b, a], { ...a, status: "ok" }, { serverId: null, status: "running" }).map((j) => j.id)).toEqual(["b"]);
    const other = [job("x", "2026-10-12T03:00:00.000Z", { serverId: "s2" })];
    expect(upsertJob(other, a, { serverId: "s2", status: null })).toBe(other);
  });
  it("ignores updates after the terminal state and older events", () => {
    const done = job("a", "2026-10-12T04:00:00.000Z", { status: "ok", progress: 100, updatedAt: "2026-10-12T04:05:00.000Z" });
    const list = [done];
    expect(upsertJob(list, { ...a, progress: 30, updatedAt: "2026-10-12T04:06:00.000Z" }, all)).toBe(list);
    const fresh = [job("a", "2026-10-12T04:00:00.000Z", { progress: 60, updatedAt: "2026-10-12T04:03:00.000Z" })];
    expect(upsertJob(fresh, { ...a, progress: 10, updatedAt: "2026-10-12T04:01:00.000Z" }, all)).toBe(fresh);
  });
});

describe("applyJobEvent", () => {
  it("updates the cached lists and appends the log chunk to the detail", () => {
    const qc = new QueryClient();
    const a = job("a", "2026-10-12T04:00:00.000Z");
    qc.setQueryData(jobsKey({ serverId: "s1" }), [a]);
    qc.setQueryData(jobsKey({ status: "running" }), [a]);
    qc.setQueryData<JobDetailDto>(jobKey("a"), { ...a, log: "save-off\n" });
    applyJobEvent(qc, { type: "job", job: { ...a, progress: 40 }, logChunk: "save-all flush\n" });
    expect(qc.getQueryData<JobDto[]>(jobsKey({ serverId: "s1" }))![0]!.progress).toBe(40);
    expect(qc.getQueryData<JobDetailDto>(jobKey("a"))!.log).toBe("save-off\nsave-all flush\n");
  });
  it("adds neither log nor status to an already terminal detail", () => {
    const qc = new QueryClient();
    const done = job("a", "2026-10-12T04:00:00.000Z", { status: "failed", updatedAt: "2026-10-12T04:05:00.000Z" });
    qc.setQueryData<JobDetailDto>(jobKey("a"), { ...done, log: "end\n" });
    applyJobEvent(qc, { type: "job", job: { ...done, status: "running", updatedAt: "2026-10-12T04:06:00.000Z" }, logChunk: "tarde\n" });
    const d = qc.getQueryData<JobDetailDto>(jobKey("a"))!;
    expect(d.log).toBe("end\n");
    expect(d.status).toBe("failed");
  });
  it("without cached data it neither creates nor cancels anything", () => {
    const qc = new QueryClient();
    applyJobEvent(qc, { type: "job", job: job("a", "2026-10-12T04:00:00.000Z"), logChunk: "x" });
    expect(qc.getQueryData(jobKey("a"))).toBeUndefined();
  });
  it("a full log replaces the accumulated one and is bounded as in the panel", () => {
    const qc = new QueryClient();
    const a = job("a", "2026-10-12T04:00:00.000Z");
    qc.setQueryData<JobDetailDto>(jobKey("a"), { ...a, log: "old\n" });
    applyJobEvent(qc, { type: "job", job: a, logChunk: "", log: "new\n" });
    expect(qc.getQueryData<JobDetailDto>(jobKey("a"))!.log).toBe("new\n");
    const big = capLog("x".repeat(MAX_JOB_LOG + 10));
    expect(big.length).toBe(MAX_JOB_LOG);
    expect(big.startsWith("…(trimmed)\n")).toBe(true);
  });
  it("does not cancel refetches of lists the event does not affect nor of the terminal detail", () => {
    const qc = new QueryClient();
    const cancel = vi.spyOn(qc, "cancelQueries");
    const other = job("x", "2026-10-12T03:00:00.000Z", { serverId: "s2" });
    qc.setQueryData(jobsKey({ serverId: "s2" }), [other]);
    const done = job("a", "2026-10-12T04:00:00.000Z", { status: "ok", updatedAt: "2026-10-12T04:05:00.000Z" });
    qc.setQueryData<JobDetailDto>(jobKey("a"), { ...done, log: "end\n" });
    vi.spyOn(qc, "isFetching").mockReturnValue(1);
    applyJobEvent(qc, { type: "job", job: { ...done, status: "running", updatedAt: "2026-10-12T04:06:00.000Z" }, logChunk: "t" });
    expect(cancel).not.toHaveBeenCalled();
  });
  it("when a job ends it reloads its server's backups and its detail", () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    applyJobEvent(qc, { type: "job", job: job("a", "2026-10-12T04:00:00.000Z", { status: "ok" }), logChunk: "" });
    expect(spy).toHaveBeenCalledWith({ queryKey: backupsKey("s1") });
    expect(spy).toHaveBeenCalledWith({ queryKey: jobKey("a") });
  });
});

describe("bindJobsLive / retainJobsLive", () => {
  it("a backup notice reloads that server's list; on reconnect it reloads everything", () => {
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
  it("several views share a single subscription", () => {
    const qc = new QueryClient();
    const f = fakeLive();
    const r1 = retainJobsLive(qc, f.live);
    const r2 = retainJobsLive(qc, f.live);
    expect(f.subscribe).toHaveBeenCalledTimes(1);
    r1();
    r1(); // releasing twice does not count double
    expect(f.handlers.has("jobs")).toBe(true);
    r2();
    expect(f.handlers.has("jobs")).toBe(false);
  });
});

describe("jobTriggerLabel", () => {
  it("translates the origin of the backup", () => {
    expect(jobTriggerLabel({ payload: { trigger: "scheduled" } })).toBe("Scheduled");
    expect(jobTriggerLabel({ payload: {} })).toBeNull();
    expect(jobTriggerLabel({ payload: { trigger: "odd" } })).toBeNull();
  });
});

describe("topicOf", () => {
  it("routes job and backups to the jobs topic", () => {
    expect(topicOf({ type: "backups", serverId: "s1" })).toBe("jobs");
    expect(topicOf({ type: "job", job: job("a", "2026-10-12T04:00:00.000Z"), logChunk: "" })).toBe("jobs");
  });
});

describe("jobsFilterFor", () => {
  it("All does not filter and the rest filter by status", () => {
    expect(jobsFilterFor(null)).toEqual({});
    expect(jobsFilterFor(["failed"])).toEqual({ status: ["failed"] });
  });
  it("offers All, Running (queue included), Successful and Failed, in that order", () => {
    expect(JOB_FILTER_OPTIONS.map((o) => [o.label, o.status])).toEqual([
      ["All", null], ["Running", ["queued", "running"]], ["Successful", ["ok"]], ["Failed", ["failed"]],
    ]);
  });
});

describe("filter with several statuses", () => {
  it("the key is the same whatever the order and matches a status in the list", () => {
    expect(jobsKey({ status: ["running", "queued"] })).toEqual(jobsKey({ status: ["queued", "running"] }));
    const q = job("q", "2026-10-12T04:00:00.000Z", { status: "queued" });
    const f = { serverId: null, status: "queued,running" };
    expect(upsertJob([], q, f).map((j) => j.id)).toEqual(["q"]);
    expect(upsertJob([], { ...q, status: "ok" }, f)).toEqual([]);
  });
});

describe("jobServerName", () => {
  const servers = [{ id: "s1", name: "One" }];
  it("shows the name if the server is in the list", () => {
    expect(jobServerName("s1", servers)).toBe("One");
  });
  it("only says deleted with the list loaded and no match", () => {
    expect(jobServerName("zz", servers)).toBe("(deleted)");
    expect(jobServerName("zz", [])).toBe("(deleted)");
  });
  it("while loading or if it failed (no list) it asserts nothing", () => {
    expect(jobServerName("s1", undefined)).toBe("…");
  });
});

describe("formatFinishTime", () => {
  it("returns null without a date or with an invalid date", () => {
    expect(formatFinishTime(null)).toBeNull();
    expect(formatFinishTime("garbage")).toBeNull();
  });
  it("formats the time of a valid date", () => {
    expect(formatFinishTime("2026-10-12T10:05:07Z")).toMatch(/\d{1,2}:\d{2}:\d{2}/);
  });
});

describe("open row of the jobs list", () => {
  const a = job("a", "2026-10-12T04:00:00.000Z");
  const b = job("b", "2026-10-12T05:00:00.000Z");
  const c = job("c", "2026-10-12T06:00:00.000Z");
  it("collapses when the filter (or server) changes", () => {
    expect(openRowId({ id: "a", filterKey: "k1" }, "k1")).toBe("a");
    expect(openRowId({ id: "a", filterKey: "k1" }, "k2")).toBeNull();
    expect(openRowId(null, "k1")).toBeNull();
  });
  it("if the open job ends while on “Running” and leaves the list, it stays in place with its latest status", () => {
    const done = { ...b, status: "ok" as const, progress: 100 };
    expect(withOpenRow([c, a], "b", done)).toEqual([c, done, a]);
  });
  it("unchanged if it is still in the list, there is no open row or the detail belongs to another job", () => {
    const list = [c, b, a];
    expect(withOpenRow(list, "b", { ...b, status: "ok" })).toBe(list);
    expect(withOpenRow([c, a], null, b)).toEqual([c, a]);
    expect(withOpenRow([c, a], "b", undefined)).toEqual([c, a]);
    expect(withOpenRow([c, a], "b", a)).toEqual([c, a]);
  });
});
