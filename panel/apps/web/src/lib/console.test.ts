import { describe, expect, it } from "vitest";
import { addHistory, applyBatch, applyMessage, stripFormatting, filterLines, initialConsole, isAtBottom, navigateHistory, pushLine } from "./console";

const log = (line: string) => ({ type: "log", serverId: "s", ts: 1, line }) as const;

describe("console", () => {
  it("bounds the buffer by discarding the oldest", () => {
    let s = initialConsole();
    for (let i = 0; i < 5; i++) s = applyMessage(s, log(`l${i}`), 0, 3);
    expect(s.lines.map((l) => l.text)).toEqual(["l2", "l3", "l4"]);
  });
  it("log_reset clears and keeps unique ids", () => {
    let s = applyMessage(initialConsole(), log("a"), 0);
    const before = s.nextId;
    s = applyMessage(s, { type: "log_reset", serverId: "s" }, 0);
    expect(s.lines).toEqual([]);
    s = applyMessage(s, log("b"), 0);
    expect(s.lines[0]!.id).toBe(before);
  });
  it("log_dropped adds a notice with pluralization", () => {
    let s = applyMessage(initialConsole(), { type: "log_dropped", serverId: "s", count: 1 }, 5);
    s = applyMessage(s, { type: "log_dropped", serverId: "s", count: 7 }, 5);
    expect(s.lines.map((l) => l.text)).toEqual(["— 1 line dropped —", "— 7 lines dropped —"]);
    expect(s.lines[0]!.kind).toBe("sys");
  });
  it("stream_closed marks the lost connection and the later reset clears it", () => {
    let s = applyMessage(initialConsole(), { type: "stream_closed", serverId: "s", reason: "x" }, 0);
    expect(s.lines[0]!.text).toBe("— connection to the node lost —");
    s = applyMessage(s, { type: "log_reset", serverId: "s" }, 0);
    expect(s.lines).toEqual([]);
  });
  it("ignores foreign messages", () => {
    const s = initialConsole();
    expect(applyMessage(s, { type: "error", message: "x" }, 0)).toBe(s);
  });
  it("filters case-insensitively", () => {
    let s = pushLine(initialConsole(), { ts: 0, text: "Joined the game", kind: "log" });
    s = pushLine(s, { ts: 0, text: "Done", kind: "log" });
    expect(filterLines(s.lines, " JOINED ").map((l) => l.text)).toEqual(["Joined the game"]);
    expect(filterLines(s.lines, "")).toHaveLength(2);
  });
  it("history: no duplicates, bounded and navigable", () => {
    let h = addHistory([], "a"); h = addHistory(h, "b"); h = addHistory(h, "a");
    expect(h).toEqual(["a", "b"]);
    expect(addHistory(Array.from({ length: 50 }, (_, i) => `c${i}`), "n")).toHaveLength(50);
    let n = navigateHistory(h, -1, "up"); expect(n).toEqual({ idx: 0, value: "a" });
    n = navigateHistory(h, n.idx, "up"); expect(n).toEqual({ idx: 1, value: "b" });
    n = navigateHistory(h, n.idx, "up"); expect(n).toEqual({ idx: 1, value: "b" });
    n = navigateHistory(h, 0, "down"); expect(n).toEqual({ idx: -1, value: "" });
    expect(navigateHistory([], -1, "up").value).toBeNull();
  });
  it("detects the end of the scroll", () => {
    expect(isAtBottom(1000, 580, 400)).toBe(true);
    expect(isAtBottom(1000, 300, 400)).toBe(false);
  });
  it("batch: respects the order, a reset in the middle clears and the limit", () => {
    const msgs = [log("a"), log("b"), { type: "log_reset", serverId: "s" } as const, log("c"), log("d"), log("e")];
    expect(applyBatch(initialConsole(), msgs, 0).lines.map((l) => l.text)).toEqual(["c", "d", "e"]);
    expect(applyBatch(initialConsole(), msgs, 0, 2).lines.map((l) => l.text)).toEqual(["d", "e"]);
    const big = Array.from({ length: 2500 }, (_, i) => log(`x${i}`));
    const r = applyBatch(initialConsole(), big, 0);
    expect(r.lines).toHaveLength(2000);
    expect(r.lines[0]!.text).toBe("x500");
    expect(new Set(r.lines.map((l) => l.id)).size).toBe(2000);
  });
  it("strips ANSI and § colour codes", () => {
    expect(stripFormatting("\x1b[32mhello\x1b[0m §agreen§r end")).toBe("hello green end");
    expect(applyBatch(initialConsole(), [log("§cbad")], 0).lines[0]!.text).toBe("bad");
  });
});
