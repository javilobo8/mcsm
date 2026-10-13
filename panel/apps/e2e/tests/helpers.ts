import { expect, type APIRequestContext, type Page } from "@playwright/test";

export const SHOTS = process.env.E2E_SHOTS ?? "screenshots";
export const NODE_A = process.env.E2E_NODE_A ?? "e2e-a";
export const NODE_B = process.env.E2E_NODE_B ?? "e2e-b";
/** Slug test-e2e-uno → contenedor mcsm-test-e2e-uno (prefijo de pruebas). */
export const SERVER = "test-e2e-uno";

/** Captura de página completa para la revisión visual (las mira el controlador). */
export async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true, animations: "disabled" });
}

export async function nodeId(api: APIRequestContext, name: string): Promise<string> {
  const nodes = (await (await api.get("/api/nodes")).json()) as { id: string; name: string }[];
  const n = nodes.find((x) => x.name === name);
  expect(n, `nodo ${name}`).toBeTruthy();
  return n!.id;
}

export async function serverByName(api: APIRequestContext, name: string): Promise<{ id: string; nodeId: string } & Record<string, unknown>> {
  const list = (await (await api.get("/api/servers")).json()) as ({ id: string; name: string; nodeId: string } & Record<string, unknown>)[];
  const s = list.find((x) => x.name === name);
  expect(s, `servidor ${name}`).toBeTruthy();
  return s!;
}

/** Sondea un sistema real (Docker, itzg) hasta que fn devuelva algo. En la E2E sí se espera. */
export async function poll<T>(fn: () => Promise<T | null | undefined | false>, what: string, timeoutMs: number, everyMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`tiempo agotado esperando ${what}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/** Errores de CSP en la consola del navegador (L10: la política no debe romper la web). */
export function watchCsp(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error" && /Content Security Policy/i.test(m.text())) errors.push(m.text()); });
  return errors;
}

/** Escrituras de la web rechazadas con 403 (p. ej. por Origin): no debe haber ninguna. */
export function watchForbidden(page: Page): string[] {
  const hits: string[] = [];
  page.on("response", (r) => {
    const m = r.request().method();
    if (r.status() === 403 && m !== "GET" && r.url().includes("/api/")) hits.push(`${m} ${r.url()}`);
  });
  return hits;
}
