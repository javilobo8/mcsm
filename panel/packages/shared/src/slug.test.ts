import { describe, expect, it } from "vitest";
import { slugify } from "./slug.js";

describe("slugify", () => {
  it("normalizes accents, spaces and uppercase", () => {
    expect(slugify("Supervivencia 2024 ñ")).toBe("supervivencia-2024-n");
    expect(slugify("  Creativo__Él & Ella  ")).toBe("creativo-el-ella");
  });
  it("truncates to 40 and never starts with a hyphen", () => {
    expect(slugify("-" + "a".repeat(60))).toHaveLength(40);
    expect(slugify("---x")).toBe("x");
  });
  it("returns 'server' if nothing is left", () => {
    expect(slugify("!!!")).toBe("server");
  });
});
