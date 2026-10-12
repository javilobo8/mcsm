import { describe, expect, it } from "vitest";
import { apiPath } from "./api";

describe("apiPath", () => {
  it("codifica cada valor interpolado y deja intacto el literal", () => {
    expect(apiPath`/api/servers/${"0190a1b2-0000-7000"}/power`).toBe("/api/servers/0190a1b2-0000-7000/power");
    expect(apiPath`/api/servers/${"x?deleteData=true#"}`).toBe("/api/servers/x%3FdeleteData%3Dtrue%23");
    expect(apiPath`/api/nodes/${"../auth/logout"}`).toBe("/api/nodes/..%2Fauth%2Flogout");
    expect(apiPath`/api/servers/${"a"}?deleteData=${false}`).toBe("/api/servers/a?deleteData=false");
    expect(apiPath`/api/servers`).toBe("/api/servers");
  });
});
