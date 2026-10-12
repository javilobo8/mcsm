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

describe("sección Router de la pestaña Red", () => {
  const routed: EditableSpec = { ...defaultSpecInput(), router: { enabled: true, hostname: "survival.lan" } };

  it("se pinta en Red con su hostname; las plantillas no la tienen", () => {
    const html = render(routed, "server");
    expect(html).toContain("Router (mc-router)");
    expect(html).toContain("survival.lan");
    expect(render(routed, "template")).not.toContain("Router (mc-router)");
    expect(sectionOfField("sf-router-hostname")).toBe("Red");
  });

  it("valida el hostname como la API", () => {
    expect(routerSectionError(undefined)).toBeNull();
    expect(routerSectionError({ enabled: true, hostname: "survival.lan" })).toBeNull();
    expect(routerSectionError({ enabled: true, hostname: "" })).toBe("Indica el hostname para entrar por el router");
    expect(routerSectionError({ enabled: false, hostname: "a_b.lan" })).toMatch(/Hostname inválido/);
  });

  it("desactivado y sin hostname vuelve a «sin sección»: no hay cambios que enviar", () => {
    const base = defaultSpecInput();
    const toggled = withRouter(withRouter(base, { enabled: true, hostname: "" }), { enabled: false, hostname: "" });
    expect("router" in toggled).toBe(false);
    expect(buildSpecPatch(base, toggled)).toEqual({});
  });

  it("el PATCH lleva la sección entera, y null al quitarla", () => {
    const base = defaultSpecInput();
    expect(buildSpecPatch(base, routed)).toEqual({ router: { enabled: true, hostname: "survival.lan" } });
    const off = withRouter(routed, { enabled: false, hostname: "survival.lan" });
    expect(buildSpecPatch(routed, off)).toEqual({ router: { enabled: false, hostname: "survival.lan" } });
    expect(buildSpecPatch(routed, withRouter(routed, { enabled: false, hostname: "" }))).toEqual({ router: null });
  });

  it("las plantillas no envían el router", () => {
    expect(TEMPLATE_KEYS).not.toContain("router");
    expect("router" in templateCreateBody("t", "", routed).spec).toBe(false);
  });

  it("el diff lo explica en castellano", () => {
    expect(diffSpecs(defaultSpecInput(), routed)).toContainEqual({ label: "Router (mc-router)", before: "—", after: "entrada por survival.lan" });
    expect(diffSpecs(routed, withRouter(routed, { enabled: false, hostname: "survival.lan" }))).toContainEqual(
      { label: "Router (mc-router)", before: "entrada por survival.lan", after: "desactivado (survival.lan)" });
  });
});
