import { describe, expect, it } from "vitest";
import { specSchema } from "@mcsm/shared";
import { proposeTarget, requiredSpace, retargetFilename, uniqueSlugAmong } from "./propose.js";

const spec = (game: number, extra: { host: number; container: number; proto: "tcp" | "udp"; label?: string }[] = [], rcon?: number) =>
  specSchema.parse({ type: "PAPER", version: "1.21.4", memory: "2G", ports: { game, extra, ...(rcon === undefined ? {} : { rcon }) }, rconPassword: "abcdefgh" });
const range = { from: 25565, to: 25570 };

describe("proposeTarget", () => {
  describe("published RCON", () => {
    it("without RCON: rconPort null, nothing changes", () => {
      expect(proposeTarget({ slug: "s", spec: spec(25565), targetServers: [], range })).toMatchObject({ rconPort: null, rconChanged: false });
    });
    it("its port is free on the target: kept", () => {
      expect(proposeTarget({ slug: "s", spec: spec(25565, [], 25570), targetServers: [{ slug: "o", spec: spec(25566) }], range }))
        .toMatchObject({ ok: true, port: 25565, rconPort: 25570, rconChanged: false });
    });
    it("taken by another server's game, extra or rcon port: the first free port of the range that is not the chosen game port", () => {
      const cases: [string, ReturnType<typeof spec>, number][] = [
        ["game", spec(25570), 25566],
        ["extra", spec(25566, [{ host: 25570, container: 8100, proto: "udp" }]), 25567],
        ["rcon", spec(25566, [], 25570), 25567],
      ];
      for (const [name, other, expected] of cases) {
        const p = proposeTarget({ slug: "s", spec: spec(25565, [], 25570), targetServers: [{ slug: "o", spec: other }], range });
        expect(p, name).toMatchObject({ ok: true, port: 25565, rconPort: expected, rconChanged: true });
      }
    });
    it("equal to the game port the user requests for the target: reassigned", () => {
      const q = proposeTarget({ slug: "s", spec: spec(25570, [], 25566), targetServers: [], range, requestedPort: 25566 });
      expect(q).toMatchObject({ ok: true, port: 25566, rconPort: 25565, rconChanged: true });
    });
    it("taken by the target's router: reassigned", () => {
      expect(proposeTarget({ slug: "s", spec: spec(25565, [], 25570), targetServers: [], range, routerPort: 25570 }))
        .toMatchObject({ ok: true, port: 25565, rconPort: 25566, rconChanged: true });
    });
    it("the new port is not one of the server's own extra ports", () => {
      const p = proposeTarget({
        slug: "s", spec: spec(25565, [{ host: 25566, container: 8100, proto: "tcp" }], 25570),
        targetServers: [{ slug: "o", spec: spec(25567, [], 25570) }], range,
      });
      expect(p).toMatchObject({ ok: true, port: 25565, rconPort: 25568, rconChanged: true });
    });
    it("an extra port of the server clashing with another server's RCON port is an error", () => {
      const p = proposeTarget({ slug: "s", spec: spec(25565, [{ host: 8100, container: 8100, proto: "tcp", label: "map" }]), targetServers: [{ slug: "o", spec: spec(25566, [], 8100) }], range });
      expect(p.ok).toBe(false);
    });
    it("no free port left for the RCON: error", () => {
      const p = proposeTarget({ slug: "s", spec: spec(25565, [], 25570), targetServers: [{ slug: "o", spec: spec(25566, [{ host: 25567, container: 1, proto: "tcp" }, { host: 25568, container: 2, proto: "tcp" }, { host: 25569, container: 3, proto: "tcp" }], 25570) }], range });
      expect(p).toEqual({ ok: false, error: "No free ports left between 25565 and 25570 for the RCON port on the target node" });
    });
    it("the automatic game port avoids the server's own RCON port when that one is free on the target", () => {
      const p = proposeTarget({ slug: "s", spec: spec(25570, [], 25566), targetServers: [{ slug: "o", spec: spec(25570) }], range });
      expect(p).toMatchObject({ port: 25565, rconPort: 25566, rconChanged: false });
      const q = proposeTarget({ slug: "s", spec: spec(25570, [], 25565), targetServers: [{ slug: "o", spec: spec(25570) }], range });
      expect(q).toMatchObject({ port: 25566, rconPort: 25565, rconChanged: false });
    });
  });

  it("keeps slug and port if they are free on the target", () => {
    expect(proposeTarget({ slug: "survival", spec: spec(25570), targetServers: [], range }))
      .toEqual({ ok: true, slug: "survival", port: 25570, portChanged: false, rconPort: null, rconChanged: false });
  });
  it("port taken: the first free one in the range that is not one of the server's own extra ports", () => {
    const p = proposeTarget({
      slug: "survival", spec: spec(25565, [{ host: 25566, container: 19132, proto: "udp" }]),
      targetServers: [{ slug: "other", spec: spec(25565) }], range,
    });
    expect(p).toEqual({ ok: true, slug: "survival", port: 25567, portChanged: true, rconPort: null, rconChanged: false });
  });
  it("reserved slug (source with the removal pending): it is avoided too", () => {
    const p = proposeTarget({ slug: "survival", spec: spec(25570), targetServers: [], reservedSlugs: ["survival"], range });
    expect(p).toMatchObject({ ok: true, slug: "survival-2", port: 25570, portChanged: false });
  });
  it("taken slug: suffix -2", () => {
    const p = proposeTarget({ slug: "survival", spec: spec(25570), targetServers: [{ slug: "survival", spec: spec(25565) }], range });
    expect(p).toMatchObject({ ok: true, slug: "survival-2", port: 25570 });
  });
  it("requested port: used if free (even if outside the range) and otherwise, error", () => {
    expect(proposeTarget({ slug: "s", spec: spec(25565), targetServers: [], range, requestedPort: 30000 }))
      .toEqual({ ok: true, slug: "s", port: 30000, portChanged: true, rconPort: null, rconChanged: false });
    const p = proposeTarget({ slug: "s", spec: spec(25565), targetServers: [{ slug: "o", spec: spec(25568) }], range, requestedPort: 25568 });
    expect(p).toEqual({ ok: false, error: "Port 25568 is already in use on the target node" });
  });
  it("an extra port that clashes on the target is not changed on its own: error", () => {
    const p = proposeTarget({
      slug: "s", spec: spec(25565, [{ host: 19132, container: 19132, proto: "udp", label: "Geyser" }]),
      targetServers: [{ slug: "o", spec: spec(25566, [{ host: 19132, container: 19132, proto: "udp" }]) }], range,
    });
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.error).toMatch(/19132 \(Geyser\)/);
  });
  it("plan-8: the target's router (mc-router) port is neither kept, nor assigned, nor can it be requested", () => {
    expect(proposeTarget({ slug: "s", spec: spec(25565), targetServers: [], range, routerPort: 25565 }))
      .toEqual({ ok: true, slug: "s", port: 25566, portChanged: true, rconPort: null, rconChanged: false });
    expect(proposeTarget({ slug: "s", spec: spec(25570), targetServers: [{ slug: "o", spec: spec(25570) }], range, routerPort: 25565 }))
      .toEqual({ ok: true, slug: "s", port: 25566, portChanged: true, rconPort: null, rconChanged: false });
    expect(proposeTarget({ slug: "s", spec: spec(25570), targetServers: [], range, routerPort: 25580, requestedPort: 25580 }))
      .toEqual({ ok: false, error: "Port 25580 is used by the target node's router (mc-router)" });
    const p = proposeTarget({ slug: "s", spec: spec(25570, [{ host: 25580, container: 8100, proto: "tcp", label: "Mapa" }]), targetServers: [], range, routerPort: 25580 });
    expect(p).toEqual({ ok: false, error: "Extra port 25580 (Mapa) is used by the target node's router (mc-router): change it before migrating" });
    // Without a router (null), nothing changes.
    expect(proposeTarget({ slug: "s", spec: spec(25565), targetServers: [], range, routerPort: null }))
      .toEqual({ ok: true, slug: "s", port: 25565, portChanged: false, rconPort: null, rconChanged: false });
  });
  it("no free ports in the range: error", () => {
    const full = [25565, 25566, 25567, 25568, 25569, 25570].map((g, i) => ({ slug: `o${i}`, spec: spec(g) }));
    expect(proposeTarget({ slug: "s", spec: spec(25565), targetServers: full, range }).ok).toBe(false);
  });
});

describe("utilities", () => {
  it("uniqueSlugAmong respects the 40 characters", () => {
    expect(uniqueSlugAmong("a", new Set(["a", "a-2"]))).toBe("a-3");
    const long = "x".repeat(40);
    expect(uniqueSlugAmong(long, new Set([long]))).toBe(`${"x".repeat(38)}-2`);
  });
  it("retargetFilename changes only the slug", () => {
    expect(retargetFilename("survival-20261012T040000.000Z-3.tar.zst", "survival", "survival-2")).toBe("survival-2-20261012T040000.000Z-3.tar.zst");
    expect(() => retargetFilename("other-20261012T040000.000Z-3.tar.zst", "survival", "x")).toThrow();
  });
  it("requiredSpace: the greater of 5 % and a 256 MiB margin", () => {
    expect(requiredSpace(0)).toBe(256 * 1024 * 1024);
    expect(requiredSpace(100 * 1024 ** 3)).toBe(105 * 1024 ** 3);
  });
});
