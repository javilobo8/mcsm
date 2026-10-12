import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { MessageInitShape } from "@bufbuild/protobuf";
import type { EnvelopeSchema, Envelope, JobStatus } from "@mcsm/proto";
import { FakeAgent } from "./fake-agent.js";

export const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

type Case = NonNullable<Envelope["body"]["case"]>;

/** Nodo de pruebas: alta real en el panel y un agente falso que responde a mano. No descarta mensajes. */
export class FakeNode {
  agent!: FakeAgent;
  private buffer: Envelope[] = [];

  private constructor(readonly url: string, readonly id: string, readonly token: string, readonly name: string) {}

  static async enroll(app: FastifyInstance, url: string, cookie: string, name: string): Promise<FakeNode> {
    const t = (await app.inject({ method: "POST", url: "/api/nodes/enrollment-tokens", headers: { cookie }, payload: { nameHint: name } })).json().token;
    const r = (await app.inject({ method: "POST", url: "/agent/enroll", payload: { enrollToken: t, nameHint: name, agentVersion: "fake" } })).json();
    return new FakeNode(url, r.nodeId, r.nodeToken, name);
  }

  /** Conecta, confirma SyncSpecs y contesta al BackupList del Hello. Devuelve el SyncSpecs. */
  async connect(specVersions: Record<string, bigint> = {}): Promise<Envelope> {
    this.buffer = [];
    this.agent = new FakeAgent(this.url, this.token);
    await this.agent.connect({ specVersions });
    const sync = await this.agent.handshake();
    this.ack(await this.next("backupList"));
    return sync;
  }

  /** Siguiente mensaje del panel de ese tipo; los demás quedan guardados para su `next`. */
  async next(c: Case, timeoutMs = 5000): Promise<Envelope> {
    const i = this.buffer.findIndex((e) => e.body.case === c);
    if (i >= 0) return this.buffer.splice(i, 1)[0]!;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`nodo ${this.name}: no llegó ${c}`);
      const e = await this.agent.next(left);
      if (e.body.case === c) return e;
      this.buffer.push(e);
    }
  }

  /** Falla si hay mensajes guardados o llega alguno en `ms`. */
  async nothingFor(ms: number): Promise<void> {
    if (this.buffer.length > 0) throw new Error(`nodo ${this.name}: pendientes ${this.buffer.map((e) => e.body.case).join(", ")}`);
    const e = await this.agent.next(ms).catch(() => null);
    if (e) throw new Error(`nodo ${this.name}: llegó ${e.body.case}`);
  }

  send(env: MessageInitShape<typeof EnvelopeSchema>): void { this.agent.send(env); }
  ack(env: Envelope): void { this.agent.ack(env.id); }
  fail(env: Envelope, code: string, message: string): void {
    this.agent.send({ id: env.id, body: { case: "error", value: { code, message } } });
  }

  progress(jobId: string, serverId: string, type: string, status: JobStatus, progress = 0, message = ""): void {
    this.agent.send({ body: { case: "jobProgress", value: { jobId, serverId, type, status, progress, message, tsUnixMs: BigInt(Date.now()) } } });
  }

  observed(serverId: string, o: { state: string; health?: string; online?: boolean; exitCode?: number; appliedVersion?: bigint }): void {
    this.agent.send({ body: { case: "serverObserved", value: {
      serverId, tsUnixMs: BigInt(Date.now()),
      observed: { state: o.state, health: o.health ?? "", exitCode: o.exitCode ?? 0, appliedVersion: o.appliedVersion ?? 0n, mc: { online: o.online ?? false } },
    } } });
  }

  /** PUT /agent/transfer/:id con el token del nodo. Devuelve el estado HTTP. */
  async put(transferId: string, body: Uint8Array): Promise<number> {
    const r = await fetch(`${this.url}/agent/transfer/${transferId}`, {
      method: "PUT", headers: { authorization: `Bearer ${this.token}`, "content-type": "application/octet-stream" }, body: new Uint8Array(body),
    });
    await r.arrayBuffer();
    return r.status;
  }

  /** GET /agent/transfer/:id con el token del nodo. */
  async get(transferId: string): Promise<Buffer> {
    const r = await fetch(`${this.url}/agent/transfer/${transferId}`, { headers: { authorization: `Bearer ${this.token}` } });
    if (!r.ok) throw new Error(`GET ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }

  close(): void { this.agent.close(); }
}
