import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { defaultSpecInput } from "@mcsm/shared";
import type { ServerDto } from "@/lib/api";
import { ExternalDataNote, ImportNotices } from "./import-notices";

const ID = "a".repeat(64);
const base = {
  id: "s1", nodeId: "n1", name: "Survival", slug: "survival", specVersion: 1, desiredState: "running", observedSpecVersion: 1,
  observedAt: null, createdAt: "", updatedAt: "", observed: null, importedFrom: null,
  spec: { ...defaultSpecInput(), ports: { game: 25565, extra: [] } },
} as unknown as ServerDto;

describe("ImportNotices (server render)", () => {
  it("a panel server renders nothing", () => {
    expect(renderToString(<ImportNotices server={base} />)).toBe("");
  });
  it("an imported server still adopted explains the recreation and the dataPath", () => {
    const s = {
      ...base,
      observed: { containerId: ID } as ServerDto["observed"],
      importedFrom: { containerId: ID, containerName: "mc-old", specVersion: 1, importedAt: "", composeProject: "", composeService: "" },
      spec: { ...base.spec, dataPath: "/home/lobo/mc/survival" },
    } as ServerDto;
    const html = renderToString(<ImportNotices server={s} />);
    expect(html).toContain("mc-old");
    expect(html).toContain("mcsm-survival");
    expect(html).toContain("/home/lobo/mc/survival");
  });
});

describe("ExternalDataNote", () => {
  it("renders the explanation as a note", () => {
    const html = renderToString(<ExternalDataNote text="The data is in /home/lobo/mc" />);
    expect(html).toContain('role="note"');
    expect(html).toContain("/home/lobo/mc");
  });
});
