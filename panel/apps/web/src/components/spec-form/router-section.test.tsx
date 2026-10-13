import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { defaultSpecInput } from "@mcsm/shared";
import { buildSpecPatch, routerSectionError, withRouter, type EditableSpec } from "@/lib/spec-edit";
import { diffSpecs } from "@/lib/spec-diff";
import { TEMPLATE_KEYS, templateCreateBody } from "@/lib/template-edit";
import { SpecForm, sectionOfField } from "./spec-form";

const render = (spec: EditableSpec, mode: "server" | "template") =>
  renderToString(
    <QueryClientProvider client={new QueryClient()}>
      <SpecForm value={spec} onChange={() => {}} onError={() => {}} mode={mode} general={<p>general</p>} />
    </QueryClientProvider>,
  );

describe("Router section of the Network tab", () => {
  const routed: EditableSpec = { ...defaultSpecInput(), router: { enabled: true, hostname: "survival.lan" } };

  it("is rendered in Network with its hostname; templates do not have it", () => {
    const html = render(routed, "server");
    expect(html).toContain("Router (mc-router)");
    expect(html).toContain("survival.lan");
    expect(render(routed, "template")).not.toContain("Router (mc-router)");
    expect(sectionOfField("sf-router-hostname")).toBe("Network");
  });

  it("validates the hostname like the API", () => {
    expect(routerSectionError(undefined)).toBeNull();
    expect(routerSectionError({ enabled: true, hostname: "survival.lan" })).toBeNull();
    expect(routerSectionError({ enabled: true, hostname: "" })).toBe("Specify the hostname to join through the router");
    expect(routerSectionError({ enabled: false, hostname: "a_b.lan" })).toMatch(/Invalid hostname/);
  });

  it("disabled and without a hostname goes back to “no section”: there are no changes to send", () => {
    const base = defaultSpecInput();
    const toggled = withRouter(withRouter(base, { enabled: true, hostname: "" }), { enabled: false, hostname: "" });
    expect("router" in toggled).toBe(false);
    expect(buildSpecPatch(base, toggled)).toEqual({});
  });

  it("the PATCH carries the whole section, and null when removing it", () => {
    const base = defaultSpecInput();
    expect(buildSpecPatch(base, routed)).toEqual({ router: { enabled: true, hostname: "survival.lan" } });
    const off = withRouter(routed, { enabled: false, hostname: "survival.lan" });
    expect(buildSpecPatch(routed, off)).toEqual({ router: { enabled: false, hostname: "survival.lan" } });
    expect(buildSpecPatch(routed, withRouter(routed, { enabled: false, hostname: "" }))).toEqual({ router: null });
  });

  it("templates do not send the router", () => {
    expect(TEMPLATE_KEYS).not.toContain("router");
    expect("router" in templateCreateBody("t", "", routed).spec).toBe(false);
  });

  it("the diff explains it in English", () => {
    expect(diffSpecs(defaultSpecInput(), routed)).toContainEqual({ label: "Router (mc-router)", before: "—", after: "entry via survival.lan" });
    expect(diffSpecs(routed, withRouter(routed, { enabled: false, hostname: "survival.lan" }))).toContainEqual(
      { label: "Router (mc-router)", before: "entry via survival.lan", after: "disabled (survival.lan)" });
  });
});
