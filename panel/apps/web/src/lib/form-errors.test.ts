import { describe, expect, it } from "vitest";
import { applyError, pruneErrors } from "./form-errors";

describe("errores agregados del formulario", () => {
  it("fusiona, sustituye y limpia sin cambiar la identidad si no hay cambio", () => {
    const a = applyError({}, "sf-env", "mal");
    expect(a).toEqual({ "sf-env": "mal" });
    expect(applyError(a, "sf-env", "mal")).toBe(a);
    expect(applyError(a, "sf-otro", null)).toBe(a);
    expect(applyError(a, "sf-env", null)).toEqual({});
  });
  it("tipo cambiado: el error de un campo oculto se purga, el de uno visible y los calculados se conservan", () => {
    const errors = { "sf-mods-urls": "URL mala", "sf-env": "mal", "sf-memlimit-rel": "limite", "sf-extra-ports": "rcon" };
    const mounted = new Set(["sf-env"]); // al pasar a Paper desaparece el fieldset de mods
    expect(pruneErrors(errors, (f) => mounted.has(f))).toEqual({ "sf-env": "mal", "sf-memlimit-rel": "limite", "sf-extra-ports": "rcon" });
  });
});
