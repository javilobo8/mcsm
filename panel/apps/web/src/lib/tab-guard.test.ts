import { describe, expect, it } from "vitest";
import { decideTabChange, tabGuardText } from "./tab-guard";

describe("decideTabChange", () => {
  it("confirms only if there are unsaved changes and the tab is switched", () => {
    expect(decideTabChange(true, "files", "console")).toBe("confirm");
    expect(decideTabChange(true, "files", "files")).toBe("switch");
    expect(decideTabChange(false, "files", "console")).toBe("switch");
  });
});

describe("tabGuardText", () => {
  it("without its own text, the generic unsaved-changes one", () => {
    expect(tabGuardText(null)).toEqual({ title: "Unsaved changes", description: "There are unsaved changes in this tab. If you switch tabs they will be lost.", confirmLabel: "Discard and switch" });
  });
  it("with its own text (e.g. an upload in progress), that one", () => {
    const w = { title: "Upload in progress", description: "There is an upload in progress. If you leave, the upload will be cancelled.", confirmLabel: "Leave and cancel the upload" };
    expect(tabGuardText(w)).toEqual(w);
  });
});
