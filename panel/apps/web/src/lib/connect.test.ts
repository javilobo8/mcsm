import { describe, expect, it } from "vitest";
import type { ServerDto } from "./api";
import { serverAddress } from "./connect";

const srv = (over: Partial<ServerDto["spec"]> = {}) => ({ spec: { ports: { game: 25566, extra: [] }, ...over } }) as unknown as Pick<ServerDto, "spec">;
const routed = (hostname: string, enabled = true) => srv({ router: { enabled, hostname } });

describe("server connection address", () => {
  it("without a configured host (and no router) there is no address", () => {
    expect(serverAddress(srv(), { host: "", port: 55567 }, null)).toBeNull();
    expect(serverAddress(srv(), undefined, null)).toBeNull();
  });

  it("configured host with the external port, or the server's own port", () => {
    expect(serverAddress(srv(), { host: "mc.example.com", port: 55567 }, null)).toBe("mc.example.com:55567");
    expect(serverAddress(srv(), { host: "mc.example.com", port: null }, null)).toBe("mc.example.com:25566");
  });

  it("port 25565 is left out, as the Minecraft client does", () => {
    expect(serverAddress(srv(), { host: "mc.example.com", port: 25565 }, null)).toBe("mc.example.com");
    expect(serverAddress(srv({ ports: { game: 25565, extra: [] } }), { host: "203.0.113.7", port: null }, null)).toBe("203.0.113.7");
  });

  it("through mc-router: the server's hostname, with the external port or the router's", () => {
    expect(serverAddress(routed("survival.example.com"), { host: "mc.example.com", port: 55567 }, 25570)).toBe("survival.example.com:55567");
    expect(serverAddress(routed("survival.example.com"), { host: "", port: null }, 25570)).toBe("survival.example.com:25570");
    expect(serverAddress(routed("survival.example.com"), undefined, null)).toBe("survival.example.com");
  });

  it("a disabled router section does not count", () => {
    expect(serverAddress(routed("survival.lan", false), { host: "mc.example.com", port: 55567 }, 25570)).toBe("mc.example.com:55567");
  });
});

import { rconAddress } from "./connect";

describe("rconAddress", () => {
  const withRcon = (rcon?: number) => ({ spec: { ports: { game: 25566, extra: [], ...(rcon ? { rcon } : {}) } } }) as unknown as Pick<ServerDto, "spec">;
  it("is null when RCON is not published", () => {
    expect(rconAddress(withRcon(), { host: "mc.example.com", port: null })).toBeNull();
  });
  it("uses the connection address host and ignores its external game port", () => {
    expect(rconAddress(withRcon(25580), { host: "mc.example.com", port: 55567 })).toBe("mc.example.com:25580");
  });
  it("ignores the router hostname", () => {
    const s = { spec: { ports: { game: 25566, extra: [], rcon: 25580 }, router: { enabled: true, hostname: "survival.example.com" } } } as unknown as Pick<ServerDto, "spec">;
    expect(rconAddress(s, { host: "mc.example.com", port: null })).toBe("mc.example.com:25580");
  });
  it("without a configured host it is just the port", () => {
    expect(rconAddress(withRcon(25580), { host: "", port: null })).toBe("25580");
    expect(rconAddress(withRcon(25580), undefined)).toBe("25580");
  });
});
