import { describe, expect, it } from "vitest";
import { canPower, displayState, fleetSummary } from "./format";

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

describe("fleetSummary", () => {
  const stopped = { state: "exited", health: "", error: "" };
  it("says when there are no servers", () => {
    expect(fleetSummary([], [])).toBe("No servers yet.");
    expect(fleetSummary([], [{ id: "a", status: "online" }])).toBe("No servers yet.");
  });
  it("counts servers, nodes and the running ones, in singular and plural", () => {
    expect(fleetSummary([{ nodeId: "a", observed: running }], [{ id: "a", status: "online" }])).toBe("1 server on 1 node, 1 running.");
    expect(fleetSummary(
      [{ nodeId: "a", observed: running }, { nodeId: "a", observed: stopped }, { nodeId: "b", observed: null }],
      [{ id: "a", status: "online" }, { id: "b", status: "online" }],
    )).toBe("3 servers on 2 nodes, 1 running.");
  });
  it("does not count as running what a node that is offline last reported, and says how many nodes are offline", () => {
    expect(fleetSummary(
      [{ nodeId: "a", observed: running }, { nodeId: "b", observed: running }],
      [{ id: "a", status: "online" }, { id: "b", status: "offline" }],
    )).toBe("2 servers on 2 nodes, 1 running. 1 node offline.");
  });
});

describe("canPower", () => {
  it("only enables actions with the node online", () => {
    expect(canPower(true)).toBe(true);
    expect(canPower(false)).toBe(false);
    expect(canPower(undefined)).toBe(true);
  });
});
