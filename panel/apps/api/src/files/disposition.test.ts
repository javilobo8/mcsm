import { describe, expect, it } from "vitest";
import { contentDisposition } from "./disposition.js";

describe("contentDisposition", () => {
  it("ASCII simple", () => {
    expect(contentDisposition("level.dat")).toBe(`attachment; filename="level.dat"; filename*=UTF-8''level.dat`);
  });
  it("acentos y emoji: reserva ASCII y nombre real codificado", () => {
    expect(contentDisposition("mundo ñ 🙂.zip")).toBe(`attachment; filename="mundo _ __.zip"; filename*=UTF-8''mundo%20%C3%B1%20%F0%9F%99%82.zip`);
  });
  it("comillas, barra invertida y % no rompen la cabecera", () => {
    const h = contentDisposition(`a"b\\c%d'(e).txt`);
    expect(h).toBe(`attachment; filename="a_b_c_d'(e).txt"; filename*=UTF-8''a%22b%5Cc%25d%27%28e%29.txt`);
  });
  it("CR/LF nunca llegan crudos (sin inyección de cabeceras)", () => {
    const h = contentDisposition("x\r\nSet-Cookie: a=1");
    expect(h).not.toMatch(/[\r\n]/);
    expect(h).toContain("x%0D%0ASet-Cookie");
  });
  it("nombre vacío → descarga", () => {
    expect(contentDisposition("")).toContain(`filename="descarga"`);
  });
  it("«;» no parte la cabecera ni en la reserva ni en el nombre codificado", () => {
    expect(contentDisposition("a; filename=evil.html")).toBe(`attachment; filename="a_ filename=evil.html"; filename*=UTF-8''a%3B%20filename%3Devil.html`);
  });
  it("un sustituto UTF-16 suelto no lanza (encodeURIComponent lanzaría URIError)", () => {
    expect(contentDisposition("a\uD800b.txt")).toBe(`attachment; filename="a_b.txt"; filename*=UTF-8''a%EF%BF%BDb.txt`);
  });
  it("solo caracteres seguros de cabecera: ASCII visible y espacio", () => {
    const h = contentDisposition("\u0000\u001f\u007f\u0085ñ\t\"x\"");
    expect(h).toMatch(/^[\x20-\x7e]+$/);
  });
});
