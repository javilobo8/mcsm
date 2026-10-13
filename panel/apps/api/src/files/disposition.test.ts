import { describe, expect, it } from "vitest";
import { contentDisposition } from "./disposition.js";

describe("contentDisposition", () => {
  it("ASCII simple", () => {
    expect(contentDisposition("level.dat")).toBe(`attachment; filename="level.dat"; filename*=UTF-8''level.dat`);
  });
  it("accents and emoji: ASCII fallback and encoded real name", () => {
    expect(contentDisposition("mundo ñ 🙂.zip")).toBe(`attachment; filename="mundo _ __.zip"; filename*=UTF-8''mundo%20%C3%B1%20%F0%9F%99%82.zip`);
  });
  it("quotes, backslash and % do not break the header", () => {
    const h = contentDisposition(`a"b\\c%d'(e).txt`);
    expect(h).toBe(`attachment; filename="a_b_c_d'(e).txt"; filename*=UTF-8''a%22b%5Cc%25d%27%28e%29.txt`);
  });
  it("CR/LF never arrive raw (no header injection)", () => {
    const h = contentDisposition("x\r\nSet-Cookie: a=1");
    expect(h).not.toMatch(/[\r\n]/);
    expect(h).toContain("x%0D%0ASet-Cookie");
  });
  it("empty name → download", () => {
    expect(contentDisposition("")).toContain(`filename="download"`);
  });
  it("“;” does not split the header, neither in the fallback nor in the encoded name", () => {
    expect(contentDisposition("a; filename=evil.html")).toBe(`attachment; filename="a_ filename=evil.html"; filename*=UTF-8''a%3B%20filename%3Devil.html`);
  });
  it("a lone UTF-16 surrogate does not throw (encodeURIComponent would throw URIError)", () => {
    expect(contentDisposition("a\uD800b.txt")).toBe(`attachment; filename="a_b.txt"; filename*=UTF-8''a%EF%BF%BDb.txt`);
  });
  it("only safe header characters: visible ASCII and space", () => {
    const h = contentDisposition("\u0000\u001f\u007f\u0085ñ\t\"x\"");
    expect(h).toMatch(/^[\x20-\x7e]+$/);
  });
});
