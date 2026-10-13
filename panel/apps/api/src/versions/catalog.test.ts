import { describe, expect, it } from "vitest";
import { ManualTimers } from "../../test/manual-timers.js";
import { BUILDS_TTL_MS, FETCH_TIMEOUT_MS, LIST_TTL_MS, MAX_BODY_BYTES, MAX_ENTRIES, VersionCatalog, type FetchFn } from "./catalog.js";

const PURPUR = "https://api.purpurmc.org/v2/purpur";
const purpurDoc = (versions: string[]) => JSON.stringify({ project: "purpur", versions });
const buildsDoc = (all: string[]) => JSON.stringify({ builds: { all } });
type Init = Parameters<FetchFn>[1];

/** fetch falso: respuestas en cola por URL; apunta cada llamada. */
function fakeFetch() {
  const calls: ({ url: string } & Init)[] = [];
  const routes = new Map<string, ((init: Init) => Promise<Response>)[]>();
  const fetch: FetchFn = (url, init) => {
    calls.push({ url, ...init });
    const next = routes.get(url)?.shift();
    return next ? next(init) : Promise.reject(new TypeError(`sin red para ${url}`));
  };
  const reply = (url: string, body: string | ((init: Init) => Promise<Response>), status = 200) => {
    const q = routes.get(url) ?? [];
    q.push(typeof body === "function" ? body : () => Promise.resolve(new Response(body, { status })));
    routes.set(url, q);
  };
  return { fetch, calls, reply };
}

function setup() {
  let now = Date.parse("2026-10-13T10:00:00Z");
  const f = fakeFetch();
  const timers = new ManualTimers();
  const errors: string[] = [];
  const catalog = new VersionCatalog({ fetch: f.fetch, now: () => now, timers, onError: (url) => errors.push(url) });
  return { catalog, ...f, timers, errors, advance: (ms: number) => { now += ms; } };
}

describe("VersionCatalog", () => {
  it("guarda la lista 1 h y la vuelve a pedir al caducar", async () => {
    const t = setup();
    t.reply(PURPUR, purpurDoc(["1.21.11", "26.2"]));
    expect(await t.catalog.versions("PURPUR")).toEqual({
      type: "PURPUR", versions: [{ id: "26.2", stable: true }, { id: "1.21.11", stable: true }],
      fetchedAt: "2026-10-13T10:00:00.000Z", stale: false,
    });
    expect(t.calls[0]!.headers["user-agent"]).toBe("mc-server-manager (self-hosted)");
    expect(t.timers.pending).toBe(0);
    t.advance(LIST_TTL_MS - 1);
    await t.catalog.versions("PURPUR");
    expect(t.calls).toHaveLength(1);
    t.reply(PURPUR, purpurDoc(["26.3"]));
    t.advance(1);
    expect((await t.catalog.versions("PURPUR")).versions).toEqual([{ id: "26.3", stable: true }]);
    expect(t.calls).toHaveLength(2);
  });

  it("si la fuente falla sirve lo guardado con stale; sin nada guardado, 502 en castellano", async () => {
    const t = setup();
    t.reply(PURPUR, purpurDoc(["26.2"]));
    await t.catalog.versions("PURPUR");
    t.advance(LIST_TTL_MS);
    t.reply(PURPUR, "caído", 503);
    expect(await t.catalog.versions("PURPUR")).toMatchObject({ stale: true, fetchedAt: "2026-10-13T10:00:00.000Z", versions: [{ id: "26.2", stable: true }] });
    expect(t.errors).toEqual([PURPUR]);

    const t2 = setup();
    t2.reply(PURPUR, "caído", 503);
    await expect(t2.catalog.versions("PURPUR")).rejects.toMatchObject({ status: 502, message: "No se pudo consultar la lista de versiones de Purpur" });
  });

  it("un 200 que no es el JSON esperado es 502, no 500", async () => {
    const t = setup();
    t.reply(PURPUR, "<html>mantenimiento</html>");
    await expect(t.catalog.versions("PURPUR")).rejects.toMatchObject({ status: 502 });
    t.reply(PURPUR, JSON.stringify({ otra: "forma" }));
    await expect(t.catalog.versions("PURPUR")).rejects.toMatchObject({ status: 502 });
  });

  it("dos consultas a la vez comparten la descarga", async () => {
    const t = setup();
    let release!: (r: Response) => void;
    t.reply(PURPUR, () => new Promise<Response>((r) => { release = r; }));
    const p1 = t.catalog.versions("PURPUR");
    const p2 = t.catalog.versions("PURPUR");
    expect(t.calls).toHaveLength(1);
    release(new Response(purpurDoc(["26.2"])));
    const [a, b] = await Promise.all([p1, p2]);
    expect(a.versions).toEqual(b.versions);
    expect(t.calls).toHaveLength(1);
  });

  it("plazo de 10 s: aborta la descarga y responde 502", async () => {
    const t = setup();
    t.reply(PURPUR, (init) => new Promise<Response>((_, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("plazo", "AbortError")));
    }));
    const p = t.catalog.versions("PURPUR");
    expect(t.timers.pending).toBe(1);
    t.timers.advance(FETCH_TIMEOUT_MS);
    await expect(p).rejects.toMatchObject({ status: 502 });
    expect(t.timers.pending).toBe(0);
  });

  it("una respuesta de más de 8 MiB es 502", async () => {
    const t = setup();
    t.reply(PURPUR, "x".repeat(MAX_BODY_BYTES + 1));
    await expect(t.catalog.versions("PURPUR")).rejects.toMatchObject({ status: 502 });
  });

  it("builds: 15 min de caché; un 4xx de la fuente es una lista vacía", async () => {
    const t = setup();
    const url = `${PURPUR}/26.2`;
    t.reply(url, buildsDoc(["2600", "2633"]));
    expect((await t.catalog.builds("PURPUR", "26.2")).builds).toEqual([
      { id: "2633", stable: true, recommended: false }, { id: "2600", stable: true, recommended: false },
    ]);
    t.advance(BUILDS_TTL_MS);
    t.reply(url, buildsDoc(["2634"]));
    expect((await t.catalog.builds("PURPUR", "26.2")).builds[0]!.id).toBe("2634");
    t.reply(`${PURPUR}/9.9.9`, JSON.stringify({ error: "version not found" }), 404);
    expect(await t.catalog.builds("PURPUR", "9.9.9")).toMatchObject({ type: "PURPUR", version: "9.9.9", builds: [], stale: false });
  });

  it("tipos sin lista, tipos sin build y versiones inválidas: 400 sin tocar la red", async () => {
    const t = setup();
    await expect(t.catalog.versions("MODRINTH")).rejects.toMatchObject({ status: 400, message: "Tipo sin lista de versiones" });
    await expect(t.catalog.versions("__proto__")).rejects.toMatchObject({ status: 400 });
    await expect(t.catalog.builds("VANILLA", "1.21.4")).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/VANILLA no admite/) });
    for (const v of ["../../etc", "1.21 ", "\u0000", "a".repeat(65), ""]) {
      await expect(t.catalog.builds("PAPER", v)).rejects.toMatchObject({ status: 400, message: "Versión inválida" });
    }
    expect(t.calls).toHaveLength(0);
  });

  it(`como mucho ${MAX_ENTRIES} entradas: se descarta la menos usada`, async () => {
    const t = setup();
    const url = (i: number) => `${PURPUR}/1.0.${i}`;
    for (let i = 0; i < MAX_ENTRIES; i++) {
      t.reply(url(i), buildsDoc([String(i)]));
      await t.catalog.builds("PURPUR", `1.0.${i}`);
    }
    await t.catalog.builds("PURPUR", "1.0.0"); // uso: pasa a ser la más reciente
    t.reply(url(MAX_ENTRIES), buildsDoc(["x"]));
    await t.catalog.builds("PURPUR", `1.0.${MAX_ENTRIES}`); // descarta 1.0.1
    const before = t.calls.length;
    await t.catalog.builds("PURPUR", "1.0.0");
    expect(t.calls).toHaveLength(before);
    t.reply(url(1), buildsDoc(["1"]));
    await t.catalog.builds("PURPUR", "1.0.1");
    expect(t.calls).toHaveLength(before + 1);
  });
});
