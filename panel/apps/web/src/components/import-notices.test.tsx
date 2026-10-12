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

describe("ImportNotices (render en servidor)", () => {
  it("un servidor del panel no pinta nada", () => {
    expect(renderToString(<ImportNotices server={base} />)).toBe("");
  });
  it("un importado aún adoptado explica la recreación y el dataPath", () => {
    const s = {
      ...base,
      observed: { containerId: ID } as ServerDto["observed"],
      importedFrom: { containerId: ID, containerName: "mc-viejo", specVersion: 1, importedAt: "", composeProject: "", composeService: "" },
      spec: { ...base.spec, dataPath: "/home/lobo/mc/survival" },
    } as ServerDto;
    const html = renderToString(<ImportNotices server={s} />);
    expect(html).toContain("mc-viejo");
    expect(html).toContain("mcsm-survival");
    expect(html).toContain("/home/lobo/mc/survival");
  });
});

describe("ExternalDataNote", () => {
  it("pinta la explicación como nota", () => {
    const html = renderToString(<ExternalDataNote text="Los datos están en /home/lobo/mc" />);
    expect(html).toContain('role="note"');
    expect(html).toContain("/home/lobo/mc");
  });
});
