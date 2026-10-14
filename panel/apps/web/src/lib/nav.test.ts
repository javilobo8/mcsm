import { describe, expect, it } from "vitest";
import { navActive } from "./nav";

describe("navActive", () => {
  it("marks Servers on the dashboard and on every server page", () => {
    expect(navActive("/", "/")).toBe(true);
    expect(navActive("/servers/abc", "/")).toBe(true);
    expect(navActive("/servers/new", "/")).toBe(true);
    expect(navActive("/nodes", "/")).toBe(false);
  });
  it("marks a section on its own page and the pages under it", () => {
    expect(navActive("/nodes", "/nodes")).toBe(true);
    expect(navActive("/nodes/n1/import", "/nodes")).toBe(true);
    expect(navActive("/templates/t1", "/templates")).toBe(true);
    expect(navActive("/jobs", "/events")).toBe(false);
  });
  it("does not match a section by prefix alone", () => {
    expect(navActive("/nodesx", "/nodes")).toBe(false);
    expect(navActive("/serversx", "/")).toBe(false);
  });
});
