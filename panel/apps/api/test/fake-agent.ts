import WebSocket from "ws";
import { create, fromBinary, toBinary, type MessageInitShape } from "@bufbuild/protobuf";
import { EnvelopeSchema, HelloSchema, type Envelope } from "@mcsm/proto";

/** Agente mínimo en TS: se conecta, saluda y deja que el test lea/escriba envelopes. */
export class FakeAgent {
  private ws!: WebSocket;
  private queue: Envelope[] = [];
  private waiters: ((e: Envelope) => void)[] = [];
  closed = false;

  constructor(private url: string, private token: string) {}

  async connect(hello: MessageInitShape<typeof HelloSchema> = {}): Promise<void> {
    this.ws = new WebSocket(this.url.replace(/^http/, "ws") + "/agent/ws", { headers: { authorization: `Bearer ${this.token}` } });
    await new Promise<void>((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", reject);
      this.ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    });
    this.ws.on("message", (data: Buffer) => {
      const env = fromBinary(EnvelopeSchema, new Uint8Array(data));
      const w = this.waiters.shift();
      if (w) w(env); else this.queue.push(env);
    });
    this.ws.on("close", () => { this.closed = true; });
    this.send({ id: 1n, body: { case: "hello", value: create(HelloSchema, { agentVersion: "fake", dockerVersion: "29", specVersions: {}, ...hello }) } });
  }

  send(env: MessageInitShape<typeof EnvelopeSchema>): void {
    this.ws.send(toBinary(EnvelopeSchema, create(EnvelopeSchema, env)));
  }

  sendRaw(data: Uint8Array): void { this.ws.send(data); }

  next(timeoutMs = 3000): Promise<Envelope> {
    const q = this.queue.shift();
    if (q) return Promise.resolve(q);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("fake agent: sin mensaje")), timeoutMs);
      this.waiters.push((e) => { clearTimeout(t); resolve(e); });
    });
  }

  /** Espera hasta recibir un envelope cuyo body.case coincida. */
  async waitFor(c: NonNullable<Envelope["body"]["case"]>, timeoutMs = 3000): Promise<Envelope> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const e = await this.next(deadline - Date.now());
      if (e.body.case === c) return e;
    }
    throw new Error(`fake agent: no llegó ${c}`);
  }

  ack(id: bigint, streamId?: bigint): void {
    this.send({ id, streamId: streamId ?? 0n, body: { case: "ack", value: {} } });
  }

  close(): void { this.ws.close(); }
}
