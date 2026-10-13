import { afterEach, describe, expect, it, vi } from "vitest";
import { createBackup } from "./use-backups";

afterEach(() => vi.unstubAllGlobals());

describe("createBackup", () => {
  it("sends POST with the Idempotency-Key header and the encoded id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "j1" }), { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    await createBackup("a/b?c", "key-1");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/servers/a%2Fb%3Fc/backups");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe("key-1");
    expect(init.body).toBeUndefined();
  });
});
