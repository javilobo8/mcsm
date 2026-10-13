import { afterEach, describe, expect, it, vi } from "vitest";
import { randomId } from "./random-id";

afterEach(() => vi.unstubAllGlobals());

describe("randomId", () => {
  it("works without crypto.randomUUID (insecure context) and gives a different UUID v4 each time", () => {
    vi.stubGlobal("crypto", { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) });
    const a = randomId();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(randomId()).not.toBe(a);
  });
});
