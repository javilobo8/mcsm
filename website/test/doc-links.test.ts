import { describe, expect, it } from "vitest";
import { parseDocsHref } from "../src/lib/doc-links";

describe("parseDocsHref", () => {
  it("reads a docs page with and without an anchor", () => {
    expect(parseDocsHref("/mcsm/docs/backups/#restoring", "/mcsm/")).toEqual({ slug: "backups", hash: "restoring" });
    expect(parseDocsHref("/mcsm/docs/backups/", "/mcsm/")).toEqual({ slug: "backups", hash: undefined });
    expect(parseDocsHref("/docs/backups/", "/")).toEqual({ slug: "backups", hash: undefined });
  });
  it("reads an anchor of the current page", () => {
    expect(parseDocsHref("#space-files-and-jobs", "/mcsm/")).toEqual({ slug: undefined, hash: "space-files-and-jobs" });
  });
  it("decodes the anchor", () => {
    expect(parseDocsHref("#caf%C3%A9", "/mcsm/")).toEqual({ slug: undefined, hash: "café" });
  });
  it("ignores anything else", () => {
    expect(parseDocsHref("https://github.com/javilobo8/mcsm", "/mcsm/")).toBeNull();
    expect(parseDocsHref("/other/docs/x/", "/mcsm/")).toBeNull();
    expect(parseDocsHref("/mcsm/screenshots/a.webp", "/mcsm/")).toBeNull();
    expect(parseDocsHref("#", "/mcsm/")).toBeNull();
  });
});
