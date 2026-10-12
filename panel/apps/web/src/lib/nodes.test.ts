import { describe, expect, it } from "vitest";
import { validateDataRoot } from "./nodes";

describe("validateDataRoot", () => {
  it("acepta rutas absolutas válidas", () => {
    expect(validateDataRoot("/srv/minecraft")).toBeNull();
    expect(validateDataRoot("/data/mc_1.2-x")).toBeNull();
  });
  it("rechaza relativas, vacías, '..' y caracteres raros", () => {
    expect(validateDataRoot("srv/mc")).not.toBeNull();
    expect(validateDataRoot("")).not.toBeNull();
    expect(validateDataRoot("/srv/../etc")).not.toBeNull();
    expect(validateDataRoot("/srv/mi carpeta")).not.toBeNull();
    expect(validateDataRoot("/" + "a".repeat(201))).not.toBeNull();
  });
});
