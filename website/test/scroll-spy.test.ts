import { describe, expect, it } from "vitest";
import { activeHeading } from "../src/lib/scroll-spy";

const hs = (...tops: number[]) => tops.map((top, i) => ({ id: `h${i}`, top }));

describe("activeHeading", () => {
  it("is undefined while every heading is below the line", () => {
    expect(activeHeading(hs(200, 600), 100, false)).toBeUndefined();
  });
  it("is the last heading that crossed the line", () => {
    expect(activeHeading(hs(-300, 50, 600), 100, false)).toBe("h1");
    expect(activeHeading(hs(-300, 100, 600), 100, false)).toBe("h1");
  });
  it("is the last heading at the bottom of the page", () => {
    expect(activeHeading(hs(-300, 50, 600), 100, true)).toBe("h2");
  });
  it("is undefined without headings", () => {
    expect(activeHeading([], 100, true)).toBeUndefined();
  });
});
