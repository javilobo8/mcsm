import { describe, expect, it } from "vitest";
import { axisValues, summarize } from "./chart-axis";
import { formatCount, formatCpu } from "./metrics";

describe("axisValues", () => {
  it("players: fractional ticks carry no label", () => {
    expect(axisValues([0, 0.5, 1, 1.5, 2], "count", formatCount)).toEqual(["0", null, "1", null, "2"]);
  });
  it("cpu: one decimal if the step is less than 1, without repeating labels", () => {
    const out = axisValues([0, 0.2, 0.4, 0.6], "percent", formatCpu);
    expect(out).toEqual(["0.0 %", "0.2 %", "0.4 %", "0.6 %"]);
    expect(new Set(out).size).toBe(out.length);
  });
  it("cpu: integers if the step is >= 1", () => {
    expect(axisValues([0, 1, 2, 3], "percent", formatCpu)).toEqual(["0 %", "1 %", "2 %", "3 %"]);
  });
  it("value: uses the formatter", () => {
    expect(axisValues([0, 5], "value", (v) => `#${v}`)).toEqual(["#0", "#5"]);
  });
});

describe("summarize", () => {
  it("last, min and max ignoring gaps; no data if everything is null", () => {
    expect(summarize([[1, 2, 3], [2, null, 4], [null, null, null]], ["A", "B"], String))
      .toBe("A: last 4, min 2, max 4. B: no data");
  });
});
