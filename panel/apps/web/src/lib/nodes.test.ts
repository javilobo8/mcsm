import { describe, expect, it } from "vitest";
import { validateDataRoot } from "./nodes";

describe("validateDataRoot", () => {
  it("accepts valid absolute paths", () => {
    expect(validateDataRoot("/srv/minecraft")).toBeNull();
    expect(validateDataRoot("/data/mc_1.2-x")).toBeNull();
  });
  it("rejects relative, empty, '..' and odd characters", () => {
    expect(validateDataRoot("srv/mc")).not.toBeNull();
    expect(validateDataRoot("")).not.toBeNull();
    expect(validateDataRoot("/srv/../etc")).not.toBeNull();
    expect(validateDataRoot("/srv/my folder")).not.toBeNull();
    expect(validateDataRoot("/" + "a".repeat(201))).not.toBeNull();
  });
});
