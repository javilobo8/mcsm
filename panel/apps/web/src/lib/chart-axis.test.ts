import { describe, expect, it } from "vitest";
import { axisValues, summarize } from "./chart-axis";
import { formatCount, formatCpu } from "./metrics";

describe("axisValues", () => {
  it("jugadores: los ticks fraccionarios no llevan etiqueta", () => {
    expect(axisValues([0, 0.5, 1, 1.5, 2], "count", formatCount)).toEqual(["0", null, "1", null, "2"]);
  });
  it("cpu: un decimal si el paso es menor que 1, sin repetir etiquetas", () => {
    const out = axisValues([0, 0.2, 0.4, 0.6], "percent", formatCpu);
    expect(out).toEqual(["0.0 %", "0.2 %", "0.4 %", "0.6 %"]);
    expect(new Set(out).size).toBe(out.length);
  });
  it("cpu: enteros si el paso es >= 1", () => {
    expect(axisValues([0, 1, 2, 3], "percent", formatCpu)).toEqual(["0 %", "1 %", "2 %", "3 %"]);
  });
  it("value: usa el formateador", () => {
    expect(axisValues([0, 5], "value", (v) => `#${v}`)).toEqual(["#0", "#5"]);
  });
});

describe("summarize", () => {
  it("último, mínimo y máximo ignorando huecos; sin datos si todo es null", () => {
    expect(summarize([[1, 2, 3], [2, null, 4], [null, null, null]], ["A", "B"], String))
      .toBe("A: último 4, mínimo 2, máximo 4. B: sin datos");
  });
});
