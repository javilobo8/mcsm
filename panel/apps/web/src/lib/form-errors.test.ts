import { describe, expect, it } from "vitest";
import { applyError, pruneErrors } from "./form-errors";

describe("aggregated form errors", () => {
  it("merges, replaces and clears without changing identity if nothing changes", () => {
    const a = applyError({}, "sf-env", "bad");
    expect(a).toEqual({ "sf-env": "bad" });
    expect(applyError(a, "sf-env", "bad")).toBe(a);
    expect(applyError(a, "sf-other", null)).toBe(a);
    expect(applyError(a, "sf-env", null)).toEqual({});
  });
  it("type changed: the error of a hidden field is purged, that of a visible one and the computed ones are kept", () => {
    const errors = { "sf-mods-urls": "bad URL", "sf-env": "bad", "sf-memlimit-rel": "limit", "sf-extra-ports": "rcon" };
    const mounted = new Set(["sf-env"]); // switching to Paper removes the mods fieldset
    expect(pruneErrors(errors, (f) => mounted.has(f))).toEqual({ "sf-env": "bad", "sf-memlimit-rel": "limit", "sf-extra-ports": "rcon" });
  });
});
