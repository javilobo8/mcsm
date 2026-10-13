import { describe, expect, it } from "vitest";
import type { ServerSpec } from "@mcsm/proto";
import { toServerSpecMessage, type ServerRow } from "./repo.js";

const row = (spec: object, extra: Partial<ServerRow> = {}): ServerRow => ({
  id: "s1", node_id: "n1", name: "A", slug: "a", spec: JSON.stringify(spec), spec_version: 3, desired_state: "running",
  observed: null, observed_spec_version: 0, observed_at: null, created_at: "", updated_at: "", ...extra,
});
const sent = (m: ServerSpec) => JSON.parse(new TextDecoder().decode(m.specJson)) as Record<string, unknown>;
const cf = row({ type: "AUTO_CURSEFORGE", modpack: { platform: "AUTO_CURSEFORGE", slugOrUrl: "all-the-mods-10" } });

describe("toServerSpecMessage", () => {
  it("the key is a required parameter: null = not configured; it only travels in CurseForge specs", () => {
    expect(sent(toServerSpecMessage(cf, "K3y"))).toHaveProperty("curseforgeApiKey", "K3y");
    expect(sent(toServerSpecMessage(cf, null))).not.toHaveProperty("curseforgeApiKey");
    expect(sent(toServerSpecMessage(row({ type: "PAPER" }), "K3y"))).not.toHaveProperty("curseforgeApiKey");
  });
  it("forgetting the key does not compile (a sender without a key would make the hash alternate with SyncSpecs and recreate the container)", () => {
    // @ts-expect-error: the CurseForge key is missing
    expect(sent(toServerSpecMessage(cf))).not.toHaveProperty("curseforgeApiKey");
  });
  it("an imported server carries adopt with the original container and the adoption version; the others do not", () => {
    const from = { containerId: "c".repeat(64), containerName: "viejo", specVersion: 1, importedAt: "", composeProject: "", composeService: "" };
    const imported = row({ type: "PAPER", dataPath: "/home/lobo/mc" }, { imported_from: JSON.stringify(from) });
    expect(sent(toServerSpecMessage(imported, null))).toMatchObject({ adopt: { containerId: "c".repeat(64), version: 1 }, dataPath: "/home/lobo/mc" });
    expect(sent(toServerSpecMessage(row({ type: "PAPER" }), null))).not.toHaveProperty("adopt");
    expect(sent(toServerSpecMessage(row({ type: "PAPER" }, { imported_from: null }), "K3y"))).not.toHaveProperty("adopt");
  });
});
