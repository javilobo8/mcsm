import { describe, expect, it } from "vitest";
import { afterEach, vi } from "vitest";
import { breadcrumbs, canEdit, canStartSave, downloadBlocker, entryOpenKind, filesApi, isClean, isSaveShortcut, leaveWarning, progressPct, sortEntries, uploadClashes, uploadCutMessage, uploadFile, validateNewName } from "./files";
import { ApiError } from "./api";

describe("breadcrumbs", () => {
  it("root and nested paths", () => {
    expect(breadcrumbs("/")).toEqual([{ name: "data", path: "/" }]);
    expect(breadcrumbs("/world/region")).toEqual([
      { name: "data", path: "/" }, { name: "world", path: "/world" }, { name: "region", path: "/world/region" },
    ]);
  });
});

describe("canEdit", () => {
  it("only known text up to 2 MiB", () => {
    expect(canEdit({ name: "server.properties", dir: false, size: 1200 })).toBe(true);
    expect(canEdit({ name: "latest.log", dir: false, size: 3 * 1024 * 1024 })).toBe(false);
    expect(canEdit({ name: "lithium.jar", dir: false, size: 10 })).toBe(false);
    expect(canEdit({ name: "config.yml", dir: true, size: 0 })).toBe(false);
  });
});

describe("validateNewName", () => {
  it("rejects empty names, slashes, .. and duplicates; allows keeping the current name", () => {
    expect(validateNewName("", [])).toMatch(/cannot be empty/);
    expect(validateNewName("a/b", [])).toMatch(/Invalid name/);
    expect(validateNewName("..", [])).toMatch(/Invalid name/);
    expect(validateNewName("mods", ["mods"])).toMatch(/already exists/);
    expect(validateNewName("mods", ["mods"], "mods")).toBeNull();
    expect(validateNewName("plugins", ["mods"])).toBeNull();
  });
});

describe("filesApi", () => {
  it("encodes the path in the download URL", () => {
    expect(filesApi.downloadUrl("s1", "/world/mundo ñ.dat")).toBe("/api/servers/s1/files/download?path=%2Fworld%2Fmundo%20%C3%B1.dat");
  });
});

describe("filesApi.uploadCheck", () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  it("sends GET to the upload-check path with the encoded id", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await filesApi.uploadCheck("a/b?c");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/servers/a%2Fb%3Fc/files/upload-check");
    expect(init.method).toBe("GET");
  });
});

describe("filesApi.downloadUrl special characters", () => {
  it("encodes # ? % & in the path and / in the id", () => {
    expect(filesApi.downloadUrl("s1", "/a#b?c%d&e.txt")).toBe("/api/servers/s1/files/download?path=%2Fa%23b%3Fc%25d%26e.txt");
    expect(filesApi.downloadUrl("a/b", "/x")).toBe("/api/servers/a%2Fb/files/download?path=%2Fx");
  });
});

describe("isClean", () => {
  it("compares the document with what is saved", () => {
    expect(isClean("abc", "abc")).toBe(true);
    expect(isClean("abd", "abc")).toBe(false);
    expect(isClean("ab", "abc")).toBe(false);
  });
  it("does not build the string if the length differs", () => {
    const toString = vi.fn(() => "abc");
    expect(isClean({ length: 2, toString }, "abc")).toBe(false);
    expect(toString).not.toHaveBeenCalled();
  });
});

describe("canStartSave", () => {
  it("only with a view, changes and no other save in flight", () => {
    expect(canStartSave({ hasView: true, dirty: true, inFlight: false })).toBe(true);
    expect(canStartSave({ hasView: true, dirty: true, inFlight: true })).toBe(false);
    expect(canStartSave({ hasView: true, dirty: false, inFlight: false })).toBe(false);
    expect(canStartSave({ hasView: false, dirty: true, inFlight: false })).toBe(false);
  });
});

describe("uploadFile", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("rejects immediately, without opening the XHR, if the signal is already aborted", async () => {
    const ctor = vi.fn();
    vi.stubGlobal("XMLHttpRequest", ctor);
    const ac = new AbortController();
    ac.abort();
    await expect(uploadFile("s1", "/a.bin", new Blob(["x"]), undefined, ac.signal)).rejects.toMatchObject({ name: "ApiError", status: 0, message: "Upload cancelled" });
    expect(ctor).not.toHaveBeenCalled();
  });
});

describe("progressPct", () => {
  it("rounds down and clamps", () => {
    expect(progressPct(0, 0)).toBe(0);
    expect(progressPct(512, 1024)).toBe(50);
    expect(progressPct(2000, 1024)).toBe(100);
  });
});

const ent = (name: string, over: Partial<{ dir: boolean; symlink: boolean; size: number }> = {}) => ({ name, dir: false, symlink: false, size: 1, modifiedAt: 0, mode: 0o644, ...over });

describe("sortEntries", () => {
  it("folders first and then by name, case-insensitive, without mutating the input", () => {
    const input = [ent("b.txt"), ent("Zeta", { dir: true }), ent("A.txt"), ent("alpha", { dir: true })];
    const out = sortEntries(input);
    expect(out.map((e) => e.name)).toEqual(["alpha", "Zeta", "A.txt", "b.txt"]);
    expect(input.map((e) => e.name)).toEqual(["b.txt", "Zeta", "A.txt", "alpha"]);
  });
});

describe("entryOpenKind", () => {
  it("folder navigates, small text edits, the rest is download only", () => {
    expect(entryOpenKind(ent("world", { dir: true }))).toBe("dir");
    expect(entryOpenKind(ent("server.properties", { size: 10 }))).toBe("edit");
    expect(entryOpenKind(ent("latest.log", { size: 3 * 1024 * 1024 }))).toBe("download");
    expect(entryOpenKind(ent("a.jar"))).toBe("download");
  });
  it("a symlink to a folder is not navigated (dir=false) and one to text is edited only if it fits", () => {
    expect(entryOpenKind(ent("link", { symlink: true }))).toBe("download");
    expect(entryOpenKind(ent("link.yml", { symlink: true }))).toBe("edit");
  });
});

describe("uploadClashes", () => {
  it("returns the names that already exist, once each", () => {
    expect(uploadClashes(["a", "b", "a", "c"], ["c", "a"])).toEqual(["a", "c"]);
    expect(uploadClashes(["x"], [])).toEqual([]);
  });
});

describe("isSaveShortcut", () => {
  it("Ctrl+S or Cmd+S without other modifiers", () => {
    expect(isSaveShortcut({ key: "s", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false })).toBe(true);
    expect(isSaveShortcut({ key: "S", ctrlKey: false, metaKey: true, altKey: false, shiftKey: false })).toBe(true);
    expect(isSaveShortcut({ key: "s", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false })).toBe(false);
    expect(isSaveShortcut({ key: "s", ctrlKey: true, metaKey: false, altKey: false, shiftKey: true })).toBe(false);
    expect(isSaveShortcut({ key: "a", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false })).toBe(false);
  });
});

describe("leaveWarning", () => {
  it("without changes or an upload there is nothing to protect", () => {
    expect(leaveWarning({ dirty: false, uploading: false, file: null })).toBeNull();
  });
  it("unsaved changes: they will be lost", () => {
    const w = leaveWarning({ dirty: true, uploading: false, file: "/server.properties" });
    expect(w?.description).toMatch(/unsaved changes in \/server\.properties/);
    expect(w?.description).not.toMatch(/upload/);
  });
  it("upload in progress: warns that it will be cancelled", () => {
    const w = leaveWarning({ dirty: false, uploading: true, file: null });
    expect(w?.title).toMatch(/Upload in progress/);
    expect(w?.description).toMatch(/the upload will be cancelled|upload in progress.*will be cancelled/i);
    expect(w?.confirmLabel).toMatch(/cancel the upload/);
  });
  it("both: mentions both", () => {
    const w = leaveWarning({ dirty: true, uploading: true, file: null });
    expect(w?.description).toMatch(/unsaved changes/);
    expect(w?.description).toMatch(/the upload will be cancelled/);
  });
});

describe("downloadBlocker", () => {
  const file = { name: "world.zip", dir: false, symlink: false, size: 10, modifiedAt: 0, mode: 0o644 };
  it("a file that exists: it is downloaded", () => {
    expect(downloadBlocker({ entry: file })).toBeNull();
  });
  it("the API error (node offline, does not exist…) is shown instead of starting the download", () => {
    expect(downloadBlocker({ error: new ApiError(409, "The node is offline") })).toBe("The node is offline");
    expect(downloadBlocker({ error: new ApiError(404, "does not exist: /world.zip") })).toBe("does not exist: /world.zip");
  });
  it("a failure that is not from the API gives a generic text", () => {
    expect(downloadBlocker({ error: new TypeError("Failed to fetch") })).toMatch(/Could not check/);
  });
  it("if it has become a folder in the meantime, it is not downloaded", () => {
    expect(downloadBlocker({ entry: { ...file, dir: true } })).toMatch(/folder/);
  });
});

describe("filesApi.stat", () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  it("asks for the encoded path at /files/stat", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ name: "a", dir: false, symlink: false, size: 1, modifiedAt: 0, mode: 420 }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await filesApi.stat("s1", "/mundo ñ.zip");
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe("/api/servers/s1/files/stat?path=%2Fmundo%20%C3%B1.zip");
  });
});

it("a large upload that was cut explains the likely causes", () => {
  expect(uploadCutMessage(1024)).toBe("Network error: the upload was cut off");
  expect(uploadCutMessage(9 * 1024 * 1024)).toMatch(/backup, restore or migration/);
  expect(uploadCutMessage(9 * 1024 * 1024)).toMatch(/UPLOAD_MAX_BYTES/);
});
