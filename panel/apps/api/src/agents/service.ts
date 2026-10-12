import type { FastifyInstance } from "fastify";
import { DesiredState, type Envelope, type Hello, type Observed } from "@mcsm/proto";
import type { AgentConn } from "./hub.js";
import { toNodeDto } from "../nodes/repo.js";
import { toServerSpecMessage, type ObservedDto, type ServerRow } from "../servers/repo.js";

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

/**
 * Una fila se reenvía en SyncSpecs si el agente no la tiene, tiene otra versión o tiene otro
 * estado deseado. Un agente que no informa `desired_states` (anterior a ese campo) solo se
 * compara por versión.
 */
export function specDiffers(r: ServerRow, hello: Hello): boolean {
  if (hello.specVersions[r.id] !== BigInt(r.spec_version)) return true;
  const agentDesired = hello.desiredStates[r.id];
  if (agentDesired === undefined) return false;
  return agentDesired !== (r.desired_state === "running" ? DesiredState.RUNNING : DesiredState.STOPPED);
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
      // ── plan-2 ──
      // ── plan-3 ──
      // ── plan-4 ──
      // ── plan-5 ──
      // ── plan-6 ──
      // ── plan-7 ──
      // ── plan-8 ──
      // ── plan-9 ──
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
    const curseforgeApiKey = this.app.curseforge.get();
    const servers = rows.filter((r) => specDiffers(r, hello)).map((r) => toServerSpecMessage(r, { curseforgeApiKey }));
    const removedIds = [...known].filter((id) => !rows.some((r) => r.id === id));
    try {
      await conn.request({ case: "syncSpecs", value: { servers, removedIds } }, 120_000);
    } catch (e) {
      // Sin la foto del panel el agente no debe recibir nada más: se corta y, al reconectar,
      // el agente repite Hello y SyncSpecs.
      this.app.log.warn({ nodeId, err: e }, "SyncSpecs sin confirmación; se cierra la conexión");
      conn.terminate();
      return;
    }
    conn.markReady();
    this.app.log.info({ nodeId, sent: servers.length, removed: removedIds.length }, "specs sincronizadas");
  }
}
