import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadDocs } from "../build/docs/load";

const repoRoot = path.join(__dirname, "fixtures/repo");
const opts = { base: "/mcsm/", repoRoot };
const page = (title: string, order: number, body: string) =>
  `---\ntitle: ${title}\ndescription: About ${title}.\nsection: Guides\norder: ${order}\n---\n\n${body}\n`;

let dir = "";
function write(files: Record<string, string>) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcsm-docs-"));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  return dir;
}
afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = "";
});

describe("loadDocs", () => {
  it("returns [] for a missing or empty directory", async () => {
    expect(await loadDocs(path.join(os.tmpdir(), "mcsm-docs-does-not-exist"), opts)).toEqual([]);
    expect(await loadDocs(write({}), opts)).toEqual([]);
  });
  it("loads, sorts by order and names the slug after the file", async () => {
    const docs = await loadDocs(write({ "b.md": page("B", 20, "## Two"), "a.md": page("A", 30, "## One"), "notes.txt": "x" }), opts);
    expect(docs.map((d) => [d.slug, d.title, d.order])).toEqual([["b", "B", 20], ["a", "A", 30]]);
    expect(docs[0]!.toc).toEqual([{ depth: 2, id: "two", text: "Two" }]);
  });
  it("records a same-page anchor as a link to its own page", async () => {
    const [d] = await loadDocs(write({ "a.md": page("A", 1, "## One\n\nBack to [one](#one) and [b](/docs/b#x).") }), opts);
    expect(d!.links).toEqual(["/docs/a#one", "/docs/b#x"]);
  });
  it("rejects a file name that is not a slug", async () => {
    await expect(loadDocs(write({ "Bad Name.md": page("A", 1, "") }), opts)).rejects.toThrow(/Bad Name\.md/);
  });
  it("rejects two pages with the same order, naming both", async () => {
    await expect(loadDocs(write({ "a.md": page("A", 5, ""), "b.md": page("B", 5, "") }), opts)).rejects.toThrow(/"a".*"b"/);
  });
  it("names the file of an invalid page", async () => {
    await expect(loadDocs(write({ "a.md": "## no frontmatter" }), opts)).rejects.toThrow(/a\.md/);
    await expect(loadDocs(write({ "h1.md": page("A", 1, "# Title") }), opts)).rejects.toThrow(/h1\.md/);
  });
});
