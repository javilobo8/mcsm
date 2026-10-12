import { describe, expect, it } from "vitest";
import { addHistory, applyBatch, applyMessage, stripFormatting, filterLines, initialConsole, isAtBottom, navigateHistory, pushLine } from "./console";

const log = (line: string) => ({ type: "log", serverId: "s", ts: 1, line }) as const;

describe("consola", () => {
  it("acota el buffer descartando lo más antiguo", () => {
    let s = initialConsole();
    for (let i = 0; i < 5; i++) s = applyMessage(s, log(`l${i}`), 0, 3);
    expect(s.lines.map((l) => l.text)).toEqual(["l2", "l3", "l4"]);
  });
  it("log_reset vacía y conserva ids únicos", () => {
    let s = applyMessage(initialConsole(), log("a"), 0);
    const before = s.nextId;
    s = applyMessage(s, { type: "log_reset", serverId: "s" }, 0);
    expect(s.lines).toEqual([]);
    s = applyMessage(s, log("b"), 0);
    expect(s.lines[0]!.id).toBe(before);
  });
  it("log_dropped añade aviso con pluralización", () => {
    let s = applyMessage(initialConsole(), { type: "log_dropped", serverId: "s", count: 1 }, 5);
    s = applyMessage(s, { type: "log_dropped", serverId: "s", count: 7 }, 5);
    expect(s.lines.map((l) => l.text)).toEqual(["— 1 línea descartada —", "— 7 líneas descartadas —"]);
    expect(s.lines[0]!.kind).toBe("sys");
  });
  it("stream_closed marca la pérdida de conexión y el reset posterior la limpia", () => {
    let s = applyMessage(initialConsole(), { type: "stream_closed", serverId: "s", reason: "x" }, 0);
    expect(s.lines[0]!.text).toBe("— conexión con el nodo perdida —");
    s = applyMessage(s, { type: "log_reset", serverId: "s" }, 0);
    expect(s.lines).toEqual([]);
  });
  it("ignora mensajes ajenos", () => {
    const s = initialConsole();
    expect(applyMessage(s, { type: "error", message: "x" }, 0)).toBe(s);
  });
  it("filtra sin distinguir mayúsculas", () => {
    let s = pushLine(initialConsole(), { ts: 0, text: "Joined the game", kind: "log" });
    s = pushLine(s, { ts: 0, text: "Done", kind: "log" });
    expect(filterLines(s.lines, " JOINED ").map((l) => l.text)).toEqual(["Joined the game"]);
    expect(filterLines(s.lines, "")).toHaveLength(2);
  });
  it("historial: sin duplicados, acotado y navegable", () => {
    let h = addHistory([], "a"); h = addHistory(h, "b"); h = addHistory(h, "a");
    expect(h).toEqual(["a", "b"]);
    expect(addHistory(Array.from({ length: 50 }, (_, i) => `c${i}`), "n")).toHaveLength(50);
    let n = navigateHistory(h, -1, "up"); expect(n).toEqual({ idx: 0, value: "a" });
    n = navigateHistory(h, n.idx, "up"); expect(n).toEqual({ idx: 1, value: "b" });
    n = navigateHistory(h, n.idx, "up"); expect(n).toEqual({ idx: 1, value: "b" });
    n = navigateHistory(h, 0, "down"); expect(n).toEqual({ idx: -1, value: "" });
    expect(navigateHistory([], -1, "up").value).toBeNull();
  });
  it("detecta el final del scroll", () => {
    expect(isAtBottom(1000, 580, 400)).toBe(true);
    expect(isAtBottom(1000, 300, 400)).toBe(false);
  });
  it("lote: respeta el orden, el reset a mitad vacía y el límite", () => {
    const msgs = [log("a"), log("b"), { type: "log_reset", serverId: "s" } as const, log("c"), log("d"), log("e")];
    expect(applyBatch(initialConsole(), msgs, 0).lines.map((l) => l.text)).toEqual(["c", "d", "e"]);
    expect(applyBatch(initialConsole(), msgs, 0, 2).lines.map((l) => l.text)).toEqual(["d", "e"]);
    const big = Array.from({ length: 2500 }, (_, i) => log(`x${i}`));
    const r = applyBatch(initialConsole(), big, 0);
    expect(r.lines).toHaveLength(2000);
    expect(r.lines[0]!.text).toBe("x500");
    expect(new Set(r.lines.map((l) => l.id)).size).toBe(2000);
  });
  it("quita ANSI y códigos § de color", () => {
    expect(stripFormatting("\x1b[32mhola\x1b[0m §averde§r fin")).toBe("hola verde fin");
    expect(applyBatch(initialConsole(), [log("§cmal")], 0).lines[0]!.text).toBe("mal");
  });
});
