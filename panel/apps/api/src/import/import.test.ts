import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { MessageInitShape } from "@bufbuild/protobuf";
import type { ImportCandidate, ImportCandidateSchema } from "@mcsm/proto";
import { specSchema } from "@mcsm/shared";
import { buildApp, type AppOptions } from "../app.js";
import { openDb } from "../db/db.js";
import { FakeAgent } from "../../test/fake-agent.js";

let app: FastifyInstance; let url: string; let cookie: string;
let nodeId: string; let nodeToken: string;

/** Starts the panel with an enrolled agent (not connected). `logger`: to capture the logs. */
async function start(logger?: AppOptions["logger"]) {
  app = await buildApp({ db: openDb(":memory:"), ...(logger ? { logger } : {}) });
  await app.listen({ port: 0, host: "127.0.0.1" });
  url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const res = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse" } });
  const c = res.cookies.find((c) => c.name === "mcsm_session")!;
  cookie = `${c.name}=${c.value}`;
  const t = (await app.inject({ method: "POST", url: "/api/nodes/enrollment-tokens", headers: { cookie }, payload: { nameHint: "nas" } })).json().token;
  ({ nodeId, nodeToken } = (await app.inject({ method: "POST", url: "/agent/enroll", payload: { enrollToken: t, nameHint: "nas", agentVersion: "fake" } })).json());
}
beforeEach(async () => { await start(); });
afterEach(async () => { await app.close(); });

const ID = "a".repeat(64);
const DATA_ROOT = "/srv/minecraft";
/** Initializer (not the message): so `Partial` and the spread keep `$typeName?: undefined`. */
type Cand = Exclude<MessageInitShape<typeof ImportCandidateSchema>, ImportCandidate>;
const candidate = (over: Partial<Cand> = {}): Cand => ({
  containerId: ID, name: "survival", image: "itzg/minecraft-server:java21", state: "running",
  env: { EULA: "TRUE", TYPE: "PAPER", VERSION: "1.21.4", MEMORY: "4G", RCON_PASSWORD: "s3cr3t-rcon-pass", CF_API_KEY: "cf-secreta-123", MOTD: "Hola" },
  ports: [{ containerPort: 25565, proto: "tcp", hostIp: "", hostPort: 25565 }],
  mounts: [{ type: "bind", source: "/home/lobo/mc/survival", destination: "/data", readWrite: true, name: "" }],
  restartPolicy: "unless-stopped", memoryLimitBytes: 0n, nanoCpus: 0n, networkMode: "bridge", networks: ["bridge"],
  labels: { "com.docker.compose.project": "casa", "com.docker.compose.service": "survival" },
  ...over,
});

const get = (u: string) => app.inject({ method: "GET", url: u, headers: { cookie } });
const post = (u: string, payload: object) => app.inject({ method: "POST", url: u, headers: { cookie }, payload });
const decode = (b: Uint8Array) => JSON.parse(new TextDecoder().decode(b)) as Record<string, unknown>;

async function online() {
  const agent = new FakeAgent(url, nodeToken);
  await agent.connect();
  await agent.handshake();
  return agent;
}
/** Answers the next ImportScan with these candidates. */
async function answerScan(agent: FakeAgent, cands: Cand[] = [candidate()]) {
  const scan = await agent.waitFor("importScan");
  agent.send({ id: scan.id, body: { case: "importScanResult", value: { dataRoot: DATA_ROOT, candidates: cands } } });
}
async function listCandidates(agent: FakeAgent, cands?: Cand[]) {
  const res = get(`/api/nodes/${nodeId}/import/candidates`);
  await answerScan(agent, cands);
  return res;
}

describe("Nodes → Import", () => {
  it("no session 401; with the node offline 409; nonexistent node 404", async () => {
    expect((await app.inject({ method: "GET", url: `/api/nodes/${nodeId}/import/candidates` })).statusCode).toBe(401);
    expect((await get(`/api/nodes/${nodeId}/import/candidates`)).statusCode).toBe(409);
    expect((await get("/api/nodes/no-existe/import/candidates")).statusCode).toBe(404);
  });

  it("candidates carry the proposal and never the secrets", async () => {
    const agent = await online();
    const res = await listCandidates(agent);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("s3cr3t-rcon-pass");
    expect(res.body).not.toContain("cf-secreta-123");
    const [c] = res.json();
    expect(c).toMatchObject({
      containerId: ID, containerName: "survival", blockers: [], hiddenEnv: ["RCON_PASSWORD", "CF_API_KEY"], composeProject: "casa",
      proposal: { slug: "survival", slugLocked: false, desiredState: "running", dataPath: "/home/lobo/mc/survival", specError: null,
        spec: { type: "PAPER", version: "1.21.4", memory: "4G", env: { MOTD: "Hola" }, ports: { game: 25565, extra: [] } } },
    });
    agent.close();
  });

  it("hot adoption: imported v1 server and ImportAdopt with adopt and the container's RCON password", async () => {
    const agent = await online();
    const [c] = (await listCandidates(agent)).json();
    const adopting = post(`/api/nodes/${nodeId}/import`, { containerId: ID, name: "Survival", slug: "survival", spec: c.proposal.spec });
    await answerScan(agent);
    const adopt = await agent.waitFor("importAdopt");
    if (adopt.body.case !== "importAdopt") throw new Error("expected importAdopt");
    const sp = adopt.body.value.server!;
    expect(sp.version).toBe(1n);
    expect(sp.slug).toBe("survival");
    expect(sp.desiredState).toBe(1); // RUNNING
    const json = decode(sp.specJson);
    expect(json).toMatchObject({ adopt: { containerId: ID, version: 1 }, rconPassword: "s3cr3t-rcon-pass", dataPath: "/home/lobo/mc/survival", type: "PAPER" });
    expect(json).not.toHaveProperty("curseforgeApiKey"); // PAPER does not use CurseForge
    agent.ack(adopt.id);
    const res = await adopting;
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      slug: "survival", specVersion: 1, desiredState: "running",
      importedFrom: { containerId: ID, containerName: "survival", specVersion: 1, composeProject: "casa", composeService: "survival" },
    });
    expect((await get("/api/settings/curseforge")).json()).toEqual({ configured: false, valid: true });
    // Already imported: it stops being a candidate even if the agent still lists it.
    expect((await listCandidates(agent)).json()).toEqual([]);
    agent.close();
  });

  it("with spec changes, hot adoption gives 409 and creates nothing or asks the agent for anything", async () => {
    const agent = await online();
    const [c] = (await listCandidates(agent)).json();
    const adopting = post(`/api/nodes/${nodeId}/import`, { containerId: ID, name: "Survival", spec: { ...c.proposal.spec, memory: "6G" } });
    await answerScan(agent);
    const res = await adopting;
    expect(res.statusCode).toBe(409);
    expect((await get("/api/servers")).json()).toEqual([]);
    agent.close();
  });

  it("Adopt and apply: after the Ack, version 2 via ApplySpec (the agent recreates) with the reviewed spec", async () => {
    const agent = await online();
    const [c] = (await listCandidates(agent)).json();
    const adopting = post(`/api/nodes/${nodeId}/import`, { containerId: ID, name: "Survival", spec: { ...c.proposal.spec, memory: "6G" }, applyNow: true });
    await answerScan(agent);
    const adopt = await agent.waitFor("importAdopt");
    agent.ack(adopt.id);
    const apply = await agent.waitFor("applySpec");
    if (apply.body.case !== "applySpec") throw new Error("expected applySpec");
    expect(apply.body.value.server!.version).toBe(2n);
    expect(decode(apply.body.value.server!.specJson)).toMatchObject({ memory: "6G", adopt: { containerId: ID, version: 1 } });
    agent.ack(apply.id);
    expect((await adopting).json()).toMatchObject({ specVersion: 2, spec: { memory: "6G" } });
    agent.close();
  });

  it("if the agent rejects the adoption, the server does not stay in the panel", async () => {
    const agent = await online();
    const [c] = (await listCandidates(agent)).json();
    const adopting = post(`/api/nodes/${nodeId}/import`, { containerId: ID, name: "Survival", spec: c.proposal.spec });
    await answerScan(agent);
    const adopt = await agent.waitFor("importAdopt");
    agent.send({ id: adopt.id, body: { case: "error", value: { code: "invalid_request", message: "the /data does not match" } } });
    const res = await adopting;
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("the /data does not match");
    expect((await get("/api/servers")).json()).toEqual([]);
    agent.close();
  });

  it("if the connection drops midway, the imported server is kept (the adoption completes on reconnect)", async () => {
    const agent = await online();
    const [c] = (await listCandidates(agent)).json();
    const adopting = post(`/api/nodes/${nodeId}/import`, { containerId: ID, name: "Survival", spec: c.proposal.spec });
    await answerScan(agent);
    await agent.waitFor("importAdopt");
    agent.close();
    const res = await adopting;
    expect(res.statusCode).toBe(504);
    const servers = (await get("/api/servers")).json();
    expect(servers).toHaveLength(1);
    expect(servers[0].importedFrom.containerId).toBe(ID);
  });

  it("data in DATA_ROOT/<slug>/data: the slug is fixed", async () => {
    const agent = await online();
    const inRoot = candidate({ mounts: [{ type: "bind", source: `${DATA_ROOT}/survival/data`, destination: "/data", readWrite: true, name: "" }] });
    const [c] = (await listCandidates(agent, [inRoot])).json();
    expect(c.proposal).toMatchObject({ slugLocked: true, dataPath: null });
    const adopting = post(`/api/nodes/${nodeId}/import`, { containerId: ID, name: "Survival", slug: "otro", spec: c.proposal.spec });
    await answerScan(agent, [inRoot]);
    expect((await adopting).statusCode).toBe(400);
    agent.close();
  });

  it("two servers do not share a data folder", async () => {
    app.servers.create({
      nodeId, name: "Otro", slug: "otro", desiredState: "stopped",
      spec: specSchema.parse({ type: "PAPER", version: "1.21.4", memory: "2G", ports: { game: 25599 }, rconPassword: "abcdefgh", dataPath: "/home/lobo/mc" }),
    });
    const agent = await online();
    const [c] = (await listCandidates(agent)).json();
    const adopting = post(`/api/nodes/${nodeId}/import`, { containerId: ID, name: "Survival", spec: c.proposal.spec });
    await answerScan(agent);
    const res = await adopting;
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("Otro");
    agent.close();
  });

  it("a container that no longer appears in the scan gives 404", async () => {
    const agent = await online();
    const adopting = post(`/api/nodes/${nodeId}/import`, { containerId: ID, name: "Survival", spec: {} });
    await answerScan(agent, []);
    expect((await adopting).statusCode).toBe(404);
    agent.close();
  });

  it("the CF_API_KEY of a CurseForge server goes to Settings if there was none and travels to the agent", async () => {
    const agent = await online();
    const cf = candidate({ env: { TYPE: "AUTO_CURSEFORGE", CF_SLUG: "all-the-mods-10", CF_API_KEY: "$2a$10$clave-cf", RCON_PASSWORD: "s3cr3t-rcon-pass" } });
    const list = await listCandidates(agent, [cf]);
    expect(list.body).not.toContain("clave-cf");
    const [c] = list.json();
    const adopting = post(`/api/nodes/${nodeId}/import`, { containerId: ID, name: "ATM", spec: c.proposal.spec });
    await answerScan(agent, [cf]);
    const adopt = await agent.waitFor("importAdopt");
    if (adopt.body.case !== "importAdopt") throw new Error("expected importAdopt");
    expect(decode(adopt.body.value.server!.specJson)).toMatchObject({ curseforgeApiKey: "$2a$10$clave-cf" });
    agent.ack(adopt.id);
    expect((await adopting).statusCode).toBe(201);
    expect(app.curseforge.get()).toBe("$2a$10$clave-cf");
    agent.close();
  });
});

describe("Nodes → Import: what the panel decides and not the browser", () => {
  it("dataPath, rconPassword and backups in the body are ignored: dataPath and RCON come from the container", async () => {
    const agent = await online();
    const [c] = (await listCandidates(agent)).json();
    const adopting = post(`/api/nodes/${nodeId}/import`, {
      containerId: ID, name: "Survival",
      spec: { ...c.proposal.spec, dataPath: "/home/lobo/otra", rconPassword: "the-browsers-own", backups: { enabled: true, cron: "0 4 * * *" } },
    });
    await answerScan(agent);
    const adopt = await agent.waitFor("importAdopt");
    if (adopt.body.case !== "importAdopt") throw new Error("expected importAdopt");
    const json = decode(adopt.body.value.server!.specJson);
    expect(json).toMatchObject({ dataPath: "/home/lobo/mc/survival", rconPassword: "s3cr3t-rcon-pass" });
    expect(json).not.toHaveProperty("backups");
    agent.ack(adopt.id);
    expect((await adopting).statusCode).toBe(201);
    agent.close();
  });

  it("an already imported container (on any node) is not a candidate and cannot be adopted again", async () => {
    const t = (await app.inject({ method: "POST", url: "/api/nodes/enrollment-tokens", headers: { cookie }, payload: { nameHint: "otro" } })).json().token;
    const other = (await app.inject({ method: "POST", url: "/agent/enroll", payload: { enrollToken: t, nameHint: "otro", agentVersion: "fake" } })).json().nodeId as string;
    const row = app.servers.create({
      nodeId: other, name: "Otro", slug: "otro", desiredState: "stopped",
      spec: specSchema.parse({ type: "PAPER", ports: { game: 25599 }, rconPassword: "abcdefgh", dataPath: "/home/lobo/otro" }),
    });
    app.servers.setImportedFrom(row.id, { containerId: ID, containerName: "survival", specVersion: 1, importedAt: "", composeProject: "", composeService: "" });
    const agent = await online();
    expect((await listCandidates(agent)).json()).toEqual([]);
    const adopting = post(`/api/nodes/${nodeId}/import`, { containerId: ID, name: "Survival", spec: {} });
    await answerScan(agent);
    expect((await adopting).statusCode).toBe(404);
    expect((await get("/api/servers")).json()).toHaveLength(1);
    agent.close();
  });

  it("if the agent rejects the adoption, the container's CF_API_KEY does not stay in Settings", async () => {
    const agent = await online();
    const cf = candidate({ env: { TYPE: "AUTO_CURSEFORGE", CF_SLUG: "all-the-mods-10", CF_API_KEY: "$2a$10$clave-cf", RCON_PASSWORD: "s3cr3t-rcon-pass" } });
    const [c] = (await listCandidates(agent, [cf])).json();
    const adopting = post(`/api/nodes/${nodeId}/import`, { containerId: ID, name: "ATM", spec: c.proposal.spec });
    await answerScan(agent, [cf]);
    const adopt = await agent.waitFor("importAdopt");
    agent.send({ id: adopt.id, body: { case: "error", value: { code: "exists", message: "already managed by another server" } } });
    expect((await adopting).statusCode).toBe(409);
    expect(app.curseforge.get()).toBeNull();
    agent.close();
  });

  it("m10: if the adoption goes unconfirmed (504), the container's CF_API_KEY is not saved in Settings", async () => {
    const agent = await online();
    const cf = candidate({ env: { TYPE: "AUTO_CURSEFORGE", CF_SLUG: "all-the-mods-10", CF_API_KEY: "$2a$10$clave-cf", RCON_PASSWORD: "s3cr3t-rcon-pass" } });
    const [c] = (await listCandidates(agent, [cf])).json();
    const adopting = post(`/api/nodes/${nodeId}/import`, { containerId: ID, name: "ATM", spec: c.proposal.spec });
    await answerScan(agent, [cf]);
    await agent.waitFor("importAdopt");
    agent.close();
    const res = await adopting;
    expect(res.statusCode).toBe(504);
    expect(res.json().error).toMatch(/Settings/);
    expect(app.curseforge.get()).toBeNull();
  });

  it("“Adopt and apply” with the connection down: the imported server is kept already at v2 (the agent will recreate on reconnect)", async () => {
    const agent = await online();
    const [c] = (await listCandidates(agent)).json();
    const adopting = post(`/api/nodes/${nodeId}/import`, { containerId: ID, name: "Survival", spec: { ...c.proposal.spec, memory: "6G" }, applyNow: true });
    await answerScan(agent);
    await agent.waitFor("importAdopt");
    agent.close();
    expect((await adopting).statusCode).toBe(504);
    const [s] = (await get("/api/servers")).json();
    expect(s).toMatchObject({ specVersion: 2, spec: { memory: "6G" }, importedFrom: { containerId: ID, specVersion: 1 } });
  });
});

describe("container secrets (RCON_PASSWORD, CF_API_KEY, rcon.password in CUSTOM_SERVER_PROPERTIES)", () => {
  it("they do not appear in the candidates, nor in the adoption response, nor in the listing, nor in the logs", async () => {
    await app.close();
    const logs: string[] = [];
    await start({ level: "trace", stream: { write: (line: string) => { logs.push(line); } } });
    const SECRETS = ["s3cr3t-rcon-pass", "$2a$10$clave-cf", "supersecreta"];
    const secretEnv = { RCON_PASSWORD: "s3cr3t-rcon-pass", CF_API_KEY: "$2a$10$clave-cf", CUSTOM_SERVER_PROPERTIES: "difficulty=hard\nrcon.password=supersecreta" };
    const atm = candidate({ env: { TYPE: "AUTO_CURSEFORGE", CF_SLUG: "all-the-mods-10", ...secretEnv } });
    const creative = candidate({
      containerId: "b".repeat(64), name: "creativo", env: { TYPE: "PAPER", ...secretEnv },
      ports: [{ containerPort: 25565, proto: "tcp", hostIp: "", hostPort: 25566 }],
      mounts: [{ type: "bind", source: "/home/lobo/mc/creativo", destination: "/data", readWrite: true, name: "" }],
    });
    const agent = await online();
    const list = await listCandidates(agent, [atm, creative]);
    const [c, c2] = list.json();

    // The agent rejects one; the other is adopted and applied, and the ApplySpec fails (the panel logs it).
    let adopting = post(`/api/nodes/${nodeId}/import`, { containerId: ID, name: "ATM", spec: c.proposal.spec });
    await answerScan(agent, [atm, creative]);
    let adopt = await agent.waitFor("importAdopt");
    agent.send({ id: adopt.id, body: { case: "error", value: { code: "invalid_request", message: "the /data does not match" } } });
    expect((await adopting).statusCode).toBe(400);
    adopting = post(`/api/nodes/${nodeId}/import`, { containerId: ID, name: "ATM", spec: c.proposal.spec, applyNow: true });
    await answerScan(agent, [atm, creative]);
    adopt = await agent.waitFor("importAdopt");
    agent.ack(adopt.id);
    const apply = await agent.waitFor("applySpec");
    agent.send({ id: apply.id, body: { case: "error", value: { code: "apply_failed", message: "docker is not responding" } } });
    const adopted = await adopting;
    expect(adopted.statusCode).toBe(201);
    const listed = await get("/api/servers");

    // The other stays unconfirmed (the panel logs it and keeps it).
    const doubtful = post(`/api/nodes/${nodeId}/import`, { containerId: "b".repeat(64), name: "Creativo", spec: c2.proposal.spec });
    await answerScan(agent, [atm, creative]);
    await agent.waitFor("importAdopt");
    agent.close();
    expect((await doubtful).statusCode).toBe(504);

    const all = logs.join("");
    expect(all).toContain("ImportAdopt unconfirmed");
    expect(all).toContain("ApplySpec failed");
    for (const body of [list.body, adopted.body, listed.body, all]) {
      for (const secret of SECRETS) expect(body).not.toContain(secret);
    }
  });
});
