import type { FastifyInstance } from "fastify";
import type { Envelope, Hello, Observed } from "@mcsm/proto";
import type { AgentConn } from "./hub.js";
import { toNodeDto } from "../nodes/repo.js";
import { toServerSpecMessage, type ObservedDto } from "../servers/repo.js";

export function observedToDto(o: Observed | undefined): ObservedDto {
  return {
    containerId: o?.containerId ?? "", state: o?.state ?? "missing", health: o?.health ?? "",
    startedAtUnix: Number(o?.startedAtUnix ?? 0n), exitCode: o?.exitCode ?? 0,
    appliedVersion: Number(o?.appliedVersion ?? 0n), error: o?.error ?? "",
    mc: {
      online: o?.mc?.online ?? false, playersOnline: o?.mc?.playersOnline ?? 0, playersMax: o?.mc?.playersMax ?? 0,
      version: o?.mc?.version ?? "", latencyMs: o?.mc?.latencyMs ?? 0,
    },
  };
}

export class AgentService {
  private lastTouch = new Map<string, number>();

  constructor(private app: FastifyInstance) {}

  start() {
    const { agents, nodes, events } = this.app;
    agents.on("attached", (nodeId: string) => {
      const row = nodes.get(nodeId);
      if (!row) return;
      nodes.setStatus(nodeId, "online");
      events.emit("node", toNodeDto(nodes.get(nodeId)!));
    });
    agents.on("detached", (nodeId: string) => {
      const row = nodes.get(nodeId);
      if (!row) return;
      nodes.setStatus(nodeId, "offline");
      events.emit("node", toNodeDto(nodes.get(nodeId)!));
    });
    agents.on("message", (nodeId: string, env: Envelope) => this.onMessage(nodeId, env));
  }

  private onMessage(nodeId: string, env: Envelope) {
    const now = Date.now();
    if ((this.lastTouch.get(nodeId) ?? 0) < now - 10_000) {
      this.app.nodes.touch(nodeId);
      this.lastTouch.set(nodeId, now);
    }
    switch (env.body.case) {
      case "hello":
        void this.onHello(nodeId, env);
        return;
      case "serverObserved": {
        const { serverId, observed } = env.body.value;
        const row = this.app.servers.get(serverId);
        if (!row || row.node_id !== nodeId) return;
        const dto = observedToDto(observed);
        this.app.servers.updateObserved(serverId, dto);
        this.app.events.emit("observed", serverId, dto);
        return;
      }
      default:
        this.app.log.warn({ nodeId, type: env.body.case }, "mensaje de agente no esperado");
    }
  }

  private async onHello(nodeId: string, env: Envelope) {
    if (env.body.case !== "hello") return;
    const hello = env.body.value;
    const conn = this.app.agents.get(nodeId);
    if (!conn) return;
    try {
      await this.handshake(nodeId, env, conn, hello);
    } catch (e) {
      this.app.log.warn({ nodeId, err: e }, "fallo en el Hello del agente; se cierra la conexión");
      conn.terminate();
    }
  }

  private async handshake(nodeId: string, env: Envelope, conn: AgentConn, hello: Hello) {
    if (!this.app.nodes.get(nodeId)) throw new Error("el nodo ya no existe");
    this.app.nodes.setStatus(nodeId, "online", {
      agentVersion: hello.agentVersion, dockerVersion: hello.dockerVersion,
      hostInfo: hello.host ? { hostname: hello.host.hostname, cpus: hello.host.cpus, memTotalBytes: Number(hello.host.memTotalBytes), os: hello.host.os, arch: hello.host.arch } : undefined,
    });
    this.app.events.emit("node", toNodeDto(this.app.nodes.get(nodeId)!));
    conn.send({ case: "helloAck", value: { nodeId } }, { id: env.id });

    const rows = this.app.servers.list(nodeId);
    const known = new Set(Object.keys(hello.specVersions));
    const servers = rows.filter((r) => hello.specVersions[r.id] !== BigInt(r.spec_version)).map(toServerSpecMessage);
    const removedIds = [...known].filter((id) => !rows.some((r) => r.id === id));
    try {
      await conn.request({ case: "syncSpecs", value: { servers, removedIds } }, 120_000);
      this.app.log.info({ nodeId, sent: servers.length, removed: removedIds.length }, "specs sincronizadas");
    } catch (e) {
      this.app.log.warn({ nodeId, err: e }, "SyncSpecs sin confirmación");
    }
  }
}
