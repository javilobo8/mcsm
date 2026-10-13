import WebSocket from "ws";
import { create, fromBinary, toBinary, type MessageInitShape } from "@bufbuild/protobuf";
import { EnvelopeSchema, HelloSchema, type Envelope } from "@mcsm/proto";

/** Minimal agent in TS: connects, greets and lets the test read/write envelopes. */
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
      const waiter = (e: Envelope) => { clearTimeout(t); resolve(e); };
      // On expiry it is removed from the queue: otherwise it would swallow the next message.
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new Error("fake agent: no message"));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  /** Waits until an envelope with a matching body.case arrives. */
  async waitFor(c: NonNullable<Envelope["body"]["case"]>, timeoutMs = 3000): Promise<Envelope> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const e = await this.next(deadline - Date.now());
      if (e.body.case === c) return e;
    }
    throw new Error(`fake agent: ${c} did not arrive`);
  }

  /** Waits for HelloAck and SyncSpecs and confirms the latter: from then on the panel sends requests. */
  async handshake(): Promise<Envelope> {
    await this.waitFor("helloAck");
    const sync = await this.waitFor("syncSpecs");
    this.ack(sync.id);
    return sync;
  }

  ack(id: bigint, streamId?: bigint): void {
    this.send({ id, streamId: streamId ?? 0n, body: { case: "ack", value: {} } });
  }

  close(): void { this.ws.close(); }
}
