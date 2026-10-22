import { expect, type APIRequestContext, type Page } from "@playwright/test";

export const SHOTS = process.env.E2E_SHOTS ?? "screenshots";
export const NODE_A = process.env.E2E_NODE_A ?? "e2e-a";
export const NODE_B = process.env.E2E_NODE_B ?? "e2e-b";
/** Slug test-e2e-one → container mcsm-test-e2e-one (test prefix). */
export const SERVER = "test-e2e-one";

/** Full-page capture for the visual review (the controller looks at them). */
export async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true, animations: "disabled" });
}

export async function nodeId(api: APIRequestContext, name: string): Promise<string> {
  const nodes = (await (await api.get("/api/nodes")).json()) as { id: string; name: string }[];
  const n = nodes.find((x) => x.name === name);
  expect(n, `node ${name}`).toBeTruthy();
  return n!.id;
}

export async function serverByName(api: APIRequestContext, name: string): Promise<{ id: string; nodeId: string } & Record<string, unknown>> {
  const list = (await (await api.get("/api/servers")).json()) as ({ id: string; name: string; nodeId: string } & Record<string, unknown>)[];
  const s = list.find((x) => x.name === name);
  expect(s, `server ${name}`).toBeTruthy();
  return s!;
}

/** Polls a real system (Docker, itzg) until fn returns something. In the E2E it does wait. */
export async function poll<T>(fn: () => Promise<T | null | undefined | false>, what: string, timeoutMs: number, everyMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/** CSP errors in the browser console (L10: the policy must not break the web). */
export function watchCsp(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error" && /Content Security Policy/i.test(m.text())) errors.push(m.text()); });
  return errors;
}

/** Web writes rejected with 403 (e.g. because of Origin): there must be none. */
export function watchForbidden(page: Page): string[] {
  const hits: string[] = [];
  page.on("response", (r) => {
    const m = r.request().method();
    if (r.status() === 403 && m !== "GET" && r.url().includes("/api/")) hits.push(`${m} ${r.url()}`);
  });
  return hits;
}

/** Minimal Source RCON client (https://developer.valvesoftware.com/wiki/Source_RCON_Protocol): login + one command. */
export async function rconExec(host: string, port: number, password: string, command: string, timeoutMs = 10_000): Promise<string> {
  const { connect } = await import("node:net");
  return new Promise<string>((resolve, reject) => {
    const sock = connect({ host, port });
    let buf = Buffer.alloc(0);
    let authed = false;
    const done = (err: Error | null, out?: string) => { clearTimeout(timer); sock.destroy(); err ? reject(err) : resolve(out ?? ""); };
    const timer = setTimeout(() => done(new Error(`RCON ${host}:${port} timed out`)), timeoutMs);
    const packet = (id: number, type: number, body: string) => {
      const b = Buffer.from(body, "utf8");
      const p = Buffer.alloc(14 + b.length);
      p.writeInt32LE(10 + b.length, 0); p.writeInt32LE(id, 4); p.writeInt32LE(type, 8); b.copy(p, 12);
      return p;
    };
    sock.on("connect", () => sock.write(packet(1, 3, password)));
    sock.on("error", (e) => done(e));
    sock.on("close", () => done(new Error("RCON connection closed before a reply")));
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 4 && buf.length >= 4 + buf.readInt32LE(0)) {
        const size = buf.readInt32LE(0);
        const id = buf.readInt32LE(4), type = buf.readInt32LE(8);
        const body = buf.subarray(12, 4 + size - 2).toString("utf8");
        buf = buf.subarray(4 + size);
        if (!authed) {
          if (type !== 2) continue; // some servers send an empty type-0 packet first
          if (id === -1) return done(new Error("RCON login rejected"));
          authed = true;
          sock.write(packet(2, 2, command));
        } else if (id === 2) {
          return done(null, body);
        }
      }
    });
  });
}

/** Default gateway of this container (= the Docker host on the compose network), from /proc/net/route. */
export async function defaultGateway(): Promise<string | null> {
  const { readFile } = await import("node:fs/promises");
  const rows = (await readFile("/proc/net/route", "utf8").catch(() => "")).split("\n").slice(1).map((l) => l.split("\t"));
  const r = rows.find((c) => c[1] === "00000000");
  if (!r?.[2]) return null;
  const n = parseInt(r[2], 16);
  return [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255].join(".");
}
