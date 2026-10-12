import { describe, expect, it } from "vitest";
import type { ServerSpec } from "@mcsm/proto";
import { toServerSpecMessage, type ServerRow } from "./repo.js";

const row = (spec: object): ServerRow => ({
  id: "s1", node_id: "n1", name: "A", slug: "a", spec: JSON.stringify(spec), spec_version: 3, desired_state: "running",
  observed: null, observed_spec_version: 0, observed_at: null, created_at: "", updated_at: "",
});
const sent = (m: ServerSpec) => JSON.parse(new TextDecoder().decode(m.specJson)) as Record<string, unknown>;
const cf = row({ type: "AUTO_CURSEFORGE", modpack: { platform: "AUTO_CURSEFORGE", slugOrUrl: "all-the-mods-10" } });

describe("toServerSpecMessage", () => {
  it("la key es un parámetro obligatorio: null = no configurada; solo viaja en specs de CurseForge", () => {
    expect(sent(toServerSpecMessage(cf, "K3y"))).toHaveProperty("curseforgeApiKey", "K3y");
    expect(sent(toServerSpecMessage(cf, null))).not.toHaveProperty("curseforgeApiKey");
    expect(sent(toServerSpecMessage(row({ type: "PAPER" }), "K3y"))).not.toHaveProperty("curseforgeApiKey");
  });
  it("olvidar la key no compila (un emisor sin key haría alternar el hash con SyncSpecs y recrearía el contenedor)", () => {
    // @ts-expect-error: falta la key de CurseForge
    expect(sent(toServerSpecMessage(cf))).not.toHaveProperty("curseforgeApiKey");
  });
});
