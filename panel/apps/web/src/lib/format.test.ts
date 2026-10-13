import { describe, expect, it } from "vitest";
import { canPower, displayState } from "./format";

const running = { state: "running", health: "healthy", error: "" };

describe("displayState", () => {
  it("shows the latest observed with the node online", () => {
    expect(displayState(running, "running", true)).toEqual({ text: "Running", tone: "ok" });
  });
  it("with the node offline it hides the stale observed", () => {
    expect(displayState(running, "running", false)).toEqual({ text: "Node offline", tone: "muted" });
  });
  it("without node information (still loading) it uses the observed", () => {
    expect(displayState(running, "running", undefined).text).toBe("Running");
  });
});

describe("canPower", () => {
  it("only enables actions with the node online", () => {
    expect(canPower(true)).toBe(true);
    expect(canPower(false)).toBe(false);
    expect(canPower(undefined)).toBe(true);
  });
});
