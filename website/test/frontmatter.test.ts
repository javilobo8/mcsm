import { describe, it, expect } from "vitest";
import { parseDoc } from "../build/docs/frontmatter";

const ok = `---\ntitle: Backups\ndescription: Hot and scheduled backups.\nsection: Guides\norder: 50\n---\n\n## Hello\n`;

describe("parseDoc", () => {
  it("splits frontmatter and body", () => {
    const { meta, body } = parseDoc(ok, "backups.md");
    expect(meta).toEqual({ title: "Backups", description: "Hot and scheduled backups.", section: "Guides", order: 50 });
    expect(body.trim()).toBe("## Hello");
  });
  it("rejects a missing frontmatter naming the file", () => {
    expect(() => parseDoc("## Hello", "x.md")).toThrow(/x\.md/);
  });
  it("rejects an unknown section", () => {
    expect(() => parseDoc(ok.replace("Guides", "Misc"), "y.md")).toThrow(/y\.md/);
  });
  it("rejects a missing description", () => {
    expect(() => parseDoc(ok.replace(/description:.*\n/, ""), "z.md")).toThrow(/z\.md/);
  });
});
