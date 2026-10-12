import { describe, expect, it } from "vitest";
import { slugify } from "./slug.js";

describe("slugify", () => {
  it("normaliza acentos, espacios y mayúsculas", () => {
    expect(slugify("Supervivencia 2024 ñ")).toBe("supervivencia-2024-n");
    expect(slugify("  Creativo__Él & Ella  ")).toBe("creativo-el-ella");
  });
  it("recorta a 40 y nunca empieza por guion", () => {
    expect(slugify("-" + "a".repeat(60))).toHaveLength(40);
    expect(slugify("---x")).toBe("x");
  });
  it("devuelve 'server' si no queda nada", () => {
    expect(slugify("!!!")).toBe("server");
  });
});
