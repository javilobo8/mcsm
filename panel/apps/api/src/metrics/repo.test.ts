import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../db/db.js";
import { MetricsRepo, type MetricRow } from "./repo.js";

const NOW = 1_760_000_017; // 10 s después de un múltiplo de 10 + 7
let db: Db;
let repo: MetricsRepo;

const row = (over: Partial<MetricRow> & Pick<MetricRow, "ts">): MetricRow => ({
  scope: "server", scopeId: "s1", cpuPct: 10, memBytes: 1000, memLimitBytes: 4000, netRxBytes: 1, netTxBytes: 2,
  diskBytes: null, diskTotalBytes: null, playersOnline: 1, playersMax: 20, tps: null, pingMs: 5, ...over,
});

beforeEach(() => {
  db = openDb(":memory:");
  repo = new MetricsRepo(db);
});

describe("MetricsRepo", () => {
  it("la migración crea la tabla con la clave (scope, scope_id, ts) y una ventana repetida se reemplaza", () => {
    repo.insertMany([row({ ts: 1_760_000_000, cpuPct: 10 }), row({ ts: 1_760_000_000, cpuPct: 30 }), row({ ts: 1_760_000_010 })]);
    expect(repo.count("server", "s1")).toBe(2);
    const s = repo.series("server", "s1", "1h", NOW);
    expect(s.cpuPct.at(-2)).toBe(30);
  });

  it("1h: 360 cubos de 10 s alineados, null donde no hay muestras", () => {
    repo.insertMany([row({ ts: 1_760_000_000, cpuPct: 12.345 }), row({ ts: 1_760_000_010, cpuPct: 50 })]);
    const s = repo.series("server", "s1", "1h", NOW);
    expect(s.step).toBe(10);
    expect(s.t).toHaveLength(360);
    expect(s.t.at(-1)).toBe(1_760_000_010);
    expect(s.t[1]! - s.t[0]!).toBe(10);
    expect(s.cpuPct.at(-1)).toBe(50);
    expect(s.cpuPct.at(-2)).toBe(12.3); // un decimal
    expect(s.cpuPct.filter((v) => v !== null)).toHaveLength(2);
    expect(s.memBytes.at(-3)).toBeNull();
  });

  it("24h agrupa por minuto con media (CPU, memoria, TPS) y máximo (jugadores), ignorando TPS nulos", () => {
    // Tres muestras en el mismo minuto [1_759_999_980, 1_760_000_040).
    const base = 1_759_999_980;
    repo.insertMany([
      row({ ts: base, cpuPct: 10, memBytes: 100, playersOnline: 1, tps: 20 }),
      row({ ts: base + 10, cpuPct: 20, memBytes: 200, playersOnline: 4, tps: null }),
      row({ ts: base + 20, cpuPct: 30, memBytes: 300, playersOnline: 2, tps: 18 }),
    ]);
    const s = repo.series("server", "s1", "24h", NOW);
    expect(s.step).toBe(60);
    expect(s.t).toHaveLength(1440);
    const i = s.t.indexOf(base);
    expect(i).toBeGreaterThan(0);
    expect(s.cpuPct[i]).toBe(20);
    expect(s.memBytes[i]).toBe(200);
    expect(s.playersOnline[i]).toBe(4);
    expect(s.tps[i]).toBe(19);
  });

  it("ts que no son múltiplo del cubo caen en su cubo (división entera)", () => {
    repo.insertMany([row({ ts: 1_760_000_000 - 7 * 60 - 10 }), row({ ts: 1_760_000_000 - 7 * 60 + 50 })]);
    const s = repo.series("server", "s1", "7d", NOW);
    expect(s.cpuPct.filter((v) => v !== null)).toHaveLength(1);
  });

  it("separa servidores y nodos y no devuelve muestras fuera del rango", () => {
    repo.insertMany([
      row({ ts: 1_760_000_000 }),
      row({ ts: 1_760_000_000, scopeId: "otro", cpuPct: 99 }),
      row({ ts: 1_760_000_000, scope: "node", cpuPct: 77 }),
      row({ ts: 1_760_000_000 - 3_600, cpuPct: 1 }), // justo fuera de la última hora
    ]);
    const s = repo.series("server", "s1", "1h", NOW);
    expect(s.cpuPct.filter((v) => v !== null)).toEqual([10]);
    expect(repo.series("node", "s1", "1h", NOW).cpuPct.at(-2)).toBe(77);
  });

  it("deleteOlderThan borra solo lo anterior al corte", () => {
    repo.insertMany([row({ ts: 100 }), row({ ts: 110 }), row({ ts: 120 })]);
    expect(repo.deleteOlderThan(120)).toBe(2);
    expect(repo.count("server", "s1")).toBe(1);
  });

  it("la consulta usa la clave primaria (sin recorrer la tabla)", () => {
    const plan = db.prepare(
      "EXPLAIN QUERY PLAN SELECT (ts / CAST(? AS INTEGER)) * CAST(? AS INTEGER) AS t, AVG(cpu_pct) FROM metric_samples WHERE scope = ? AND scope_id = ? AND ts >= ? AND ts < ? GROUP BY t",
    ).all(10, 10, "server", "s1", 0, 1) as { detail: string }[];
    expect(plan.map((p) => p.detail).join(" | ")).toMatch(/USING PRIMARY KEY \(scope=\? AND scope_id=\? AND ts>\? AND ts<\?\)/);
  });
});

describe("planes de consulta", () => {
  const plan = (sql: string, ...args: (string | number)[]) =>
    (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as { detail: string }[]).map((r) => r.detail).join(" | ");

  it("la purga usa un índice por ts, no recorre la tabla", () => {
    const p = plan("DELETE FROM metric_samples WHERE ts < ?", 1);
    expect(p).toMatch(/USING (COVERING )?INDEX/);
    expect(p).not.toMatch(/SCAN metric_samples(?! USING)/);
  });

  it("la serie de 7 d usa la clave primaria (scope, scope_id, ts)", () => {
    const p = plan("SELECT ts FROM metric_samples WHERE scope = ? AND scope_id = ? AND ts >= ? AND ts < ?", "server", "s1", 1, 2);
    expect(p).toMatch(/SEARCH metric_samples USING (PRIMARY KEY|INDEX)/);
    expect(p).toContain("scope=? AND scope_id=? AND ts>? AND ts<?");
  });
});
