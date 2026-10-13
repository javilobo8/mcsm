import { describe, expect, it } from "vitest";
import { afterEach, vi } from "vitest";
import { breadcrumbs, canEdit, canStartSave, downloadBlocker, entryOpenKind, filesApi, isClean, isSaveShortcut, leaveWarning, progressPct, sortEntries, uploadClashes, uploadCutMessage, uploadFile, validateNewName } from "./files";
import { ApiError } from "./api";

describe("breadcrumbs", () => {
  it("raíz y rutas anidadas", () => {
    expect(breadcrumbs("/")).toEqual([{ name: "data", path: "/" }]);
    expect(breadcrumbs("/world/region")).toEqual([
      { name: "data", path: "/" }, { name: "world", path: "/world" }, { name: "region", path: "/world/region" },
    ]);
  });
});

describe("canEdit", () => {
  it("solo texto conocido de hasta 2 MiB", () => {
    expect(canEdit({ name: "server.properties", dir: false, size: 1200 })).toBe(true);
    expect(canEdit({ name: "latest.log", dir: false, size: 3 * 1024 * 1024 })).toBe(false);
    expect(canEdit({ name: "lithium.jar", dir: false, size: 10 })).toBe(false);
    expect(canEdit({ name: "config.yml", dir: true, size: 0 })).toBe(false);
  });
});

describe("validateNewName", () => {
  it("rechaza vacíos, barras, .. y duplicados; permite conservar el nombre actual", () => {
    expect(validateNewName("", [])).toMatch(/vacío/);
    expect(validateNewName("a/b", [])).toMatch(/inválido/);
    expect(validateNewName("..", [])).toMatch(/inválido/);
    expect(validateNewName("mods", ["mods"])).toMatch(/Ya existe/);
    expect(validateNewName("mods", ["mods"], "mods")).toBeNull();
    expect(validateNewName("plugins", ["mods"])).toBeNull();
  });
});

describe("filesApi", () => {
  it("codifica la ruta en la URL de descarga", () => {
    expect(filesApi.downloadUrl("s1", "/world/mundo ñ.dat")).toBe("/api/servers/s1/files/download?path=%2Fworld%2Fmundo%20%C3%B1.dat");
  });
});

describe("filesApi.downloadUrl caracteres especiales", () => {
  it("codifica # ? % & en la ruta y / en el id", () => {
    expect(filesApi.downloadUrl("s1", "/a#b?c%d&e.txt")).toBe("/api/servers/s1/files/download?path=%2Fa%23b%3Fc%25d%26e.txt");
    expect(filesApi.downloadUrl("a/b", "/x")).toBe("/api/servers/a%2Fb/files/download?path=%2Fx");
  });
});

describe("isClean", () => {
  it("compara el documento con lo guardado", () => {
    expect(isClean("abc", "abc")).toBe(true);
    expect(isClean("abd", "abc")).toBe(false);
    expect(isClean("ab", "abc")).toBe(false);
  });
  it("no construye la cadena si la longitud difiere", () => {
    const toString = vi.fn(() => "abc");
    expect(isClean({ length: 2, toString }, "abc")).toBe(false);
    expect(toString).not.toHaveBeenCalled();
  });
});

describe("canStartSave", () => {
  it("solo con vista, cambios y sin otro guardado en vuelo", () => {
    expect(canStartSave({ hasView: true, dirty: true, inFlight: false })).toBe(true);
    expect(canStartSave({ hasView: true, dirty: true, inFlight: true })).toBe(false);
    expect(canStartSave({ hasView: true, dirty: false, inFlight: false })).toBe(false);
    expect(canStartSave({ hasView: false, dirty: true, inFlight: false })).toBe(false);
  });
});

describe("uploadFile", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("rechaza al momento, sin abrir el XHR, si la señal ya está abortada", async () => {
    const ctor = vi.fn();
    vi.stubGlobal("XMLHttpRequest", ctor);
    const ac = new AbortController();
    ac.abort();
    await expect(uploadFile("s1", "/a.bin", new Blob(["x"]), undefined, ac.signal)).rejects.toMatchObject({ name: "ApiError", status: 0, message: "Subida cancelada" });
    expect(ctor).not.toHaveBeenCalled();
  });
});

describe("progressPct", () => {
  it("redondea hacia abajo y acota", () => {
    expect(progressPct(0, 0)).toBe(0);
    expect(progressPct(512, 1024)).toBe(50);
    expect(progressPct(2000, 1024)).toBe(100);
  });
});

const ent = (name: string, over: Partial<{ dir: boolean; symlink: boolean; size: number }> = {}) => ({ name, dir: false, symlink: false, size: 1, modifiedAt: 0, mode: 0o644, ...over });

describe("sortEntries", () => {
  it("carpetas primero y después por nombre sin distinguir mayúsculas, sin mutar la entrada", () => {
    const input = [ent("b.txt"), ent("Zeta", { dir: true }), ent("A.txt"), ent("alfa", { dir: true })];
    const out = sortEntries(input);
    expect(out.map((e) => e.name)).toEqual(["alfa", "Zeta", "A.txt", "b.txt"]);
    expect(input.map((e) => e.name)).toEqual(["b.txt", "Zeta", "A.txt", "alfa"]);
  });
});

describe("entryOpenKind", () => {
  it("carpeta navega, texto pequeño edita, el resto solo se descarga", () => {
    expect(entryOpenKind(ent("world", { dir: true }))).toBe("dir");
    expect(entryOpenKind(ent("server.properties", { size: 10 }))).toBe("edit");
    expect(entryOpenKind(ent("latest.log", { size: 3 * 1024 * 1024 }))).toBe("download");
    expect(entryOpenKind(ent("a.jar"))).toBe("download");
  });
  it("un enlace simbólico a carpeta no se navega (dir=false) y uno a texto se edita solo si cabe", () => {
    expect(entryOpenKind(ent("link", { symlink: true }))).toBe("download");
    expect(entryOpenKind(ent("link.yml", { symlink: true }))).toBe("edit");
  });
});

describe("uploadClashes", () => {
  it("devuelve los nombres que ya existen, una vez cada uno", () => {
    expect(uploadClashes(["a", "b", "a", "c"], ["c", "a"])).toEqual(["a", "c"]);
    expect(uploadClashes(["x"], [])).toEqual([]);
  });
});

describe("isSaveShortcut", () => {
  it("Ctrl+S o Cmd+S sin otros modificadores", () => {
    expect(isSaveShortcut({ key: "s", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false })).toBe(true);
    expect(isSaveShortcut({ key: "S", ctrlKey: false, metaKey: true, altKey: false, shiftKey: false })).toBe(true);
    expect(isSaveShortcut({ key: "s", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false })).toBe(false);
    expect(isSaveShortcut({ key: "s", ctrlKey: true, metaKey: false, altKey: false, shiftKey: true })).toBe(false);
    expect(isSaveShortcut({ key: "a", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false })).toBe(false);
  });
});

describe("leaveWarning", () => {
  it("sin cambios ni subida no hay nada que proteger", () => {
    expect(leaveWarning({ dirty: false, uploading: false, file: null })).toBeNull();
  });
  it("cambios sin guardar: se perderán", () => {
    const w = leaveWarning({ dirty: true, uploading: false, file: "/server.properties" });
    expect(w?.description).toMatch(/cambios sin guardar en \/server\.properties/);
    expect(w?.description).not.toMatch(/subida/);
  });
  it("subida en curso: avisa de que se cancelará", () => {
    const w = leaveWarning({ dirty: false, uploading: true, file: null });
    expect(w?.title).toMatch(/Subida en curso/);
    expect(w?.description).toMatch(/se cancelará la subida|subida en curso.*se cancelará/i);
    expect(w?.confirmLabel).toMatch(/cancelar la subida/);
  });
  it("las dos cosas: menciona ambas", () => {
    const w = leaveWarning({ dirty: true, uploading: true, file: null });
    expect(w?.description).toMatch(/cambios sin guardar/);
    expect(w?.description).toMatch(/se cancelará la subida/);
  });
});

describe("downloadBlocker", () => {
  const file = { name: "world.zip", dir: false, symlink: false, size: 10, modifiedAt: 0, mode: 0o644 };
  it("un fichero que existe: se descarga", () => {
    expect(downloadBlocker({ entry: file })).toBeNull();
  });
  it("el error de la API (nodo desconectado, no existe…) se muestra en vez de lanzar la descarga", () => {
    expect(downloadBlocker({ error: new ApiError(409, "El nodo está desconectado") })).toBe("El nodo está desconectado");
    expect(downloadBlocker({ error: new ApiError(404, "no existe: /world.zip") })).toBe("no existe: /world.zip");
  });
  it("un fallo que no es de la API da un texto genérico", () => {
    expect(downloadBlocker({ error: new TypeError("Failed to fetch") })).toMatch(/No se pudo comprobar/);
  });
  it("si entretanto se convirtió en carpeta, no se descarga", () => {
    expect(downloadBlocker({ entry: { ...file, dir: true } })).toMatch(/carpeta/);
  });
});

describe("filesApi.stat", () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  it("pide la ruta codificada a /files/stat", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ name: "a", dir: false, symlink: false, size: 1, modifiedAt: 0, mode: 420 }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await filesApi.stat("s1", "/mundo ñ.zip");
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe("/api/servers/s1/files/stat?path=%2Fmundo%20%C3%B1.zip");
  });
});

it("una subida grande cortada explica las causas probables", () => {
  expect(uploadCutMessage(1024)).toBe("Error de red: la subida se cortó");
  expect(uploadCutMessage(9 * 1024 * 1024)).toMatch(/copia, restauración o migración/);
  expect(uploadCutMessage(9 * 1024 * 1024)).toMatch(/UPLOAD_MAX_BYTES/);
});
