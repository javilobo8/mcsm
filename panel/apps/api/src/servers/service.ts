import type { FastifyInstance } from "fastify";
import { PowerActionType } from "@mcsm/proto";
import {
  canonicalJson, dataPathPatchError, formatZodError, mergeSpecPatch, specInputSchema, specPatchNullError, specSizeError, usesCurseForge, specSchema, slugify,
  type ServerCreateInput, type Spec, type SpecInput, type SpecPatch, type PowerActionName,
} from "@mcsm/shared";
import type { z } from "zod";
import { randomToken } from "../lib/tokens.js";
import { HttpError, agentErrorToHttp } from "../lib/http.js";
import { toServerDto, toServerSpecMessage, type ServerRow } from "./repo.js";

// HttpError lives in lib/http.ts; it is re-exported for code that imports it from here.
export { HttpError };

const POWER: Record<PowerActionName, PowerActionType> = {
  start: PowerActionType.START, stop: PowerActionType.STOP, restart: PowerActionType.RESTART, kill: PowerActionType.KILL,
};

export class ServersService {
  constructor(private app: FastifyInstance) {}

  private requireNode(nodeId: string) {
    const node = this.app.nodes.get(nodeId);
    if (!node) throw new HttpError(404, "Node not found");
    return node;
  }

  private requireServer(id: string): ServerRow {
    const row = this.app.servers.get(id);
    if (!row) throw new HttpError(404, "Server not found");
    return row;
  }

  private onlineConn(nodeId: string) {
    const conn = this.app.agents.get(nodeId);
    if (!conn) throw new HttpError(409, "The node is offline");
    return conn;
  }

  allocatePort(nodeId: string, exclude = new Set<number>()): number {
    const used = this.app.servers.usedGamePorts(nodeId);
    for (const p of this.app.migrations.reservedPorts(nodeId)) used.add(p); // plan-7: migrations towards the node
    const { from, to } = this.app.settings.gamePortRange();
    const routerPort = this.app.routerService.reservedPort(nodeId); // plan-8: the router's port is not assigned
    if (routerPort !== null) used.add(routerPort);
    for (let p = from; p <= to; p++) if (!used.has(p) && !exclude.has(p)) return p;
    throw new HttpError(409, `No free ports left between ${from} and ${to} on this node`);
  }

  /** Adds `-2`, `-3`… as a suffix respecting the 40-character maximum. */
  private uniqueSlug(nodeId: string, base: string): string {
    if (!this.app.servers.getBySlug(nodeId, base)) return base;
    for (let n = 2; ; n++) {
      const suffix = `-${n}`;
      const candidate = base.slice(0, 40 - suffix.length).replace(/-+$/g, "") + suffix;
      if (!this.app.servers.getBySlug(nodeId, candidate)) return candidate;
    }
  }

  /** Spec ports free on the node (also used by import, plan-6). */
  checkPorts(nodeId: string, spec: Spec, selfId?: string) {
    const reserved = this.app.migrations.reservedPorts(nodeId, selfId); // plan-7: migrations towards the node
    const used = new Set<number>();
    for (const r of this.app.servers.list(nodeId)) {
      if (r.id === selfId) continue;
      const s = JSON.parse(r.spec) as Spec;
      used.add(s.ports.game);
      for (const e of s.ports.extra) used.add(e.host);
    }
    const mine = [spec.ports.game, ...spec.ports.extra.map((e) => e.host)];
    for (const p of mine) if (used.has(p)) throw new HttpError(409, `Port ${p} is already used by another server on this node`);
    for (const p of mine) if (reserved.has(p)) throw new HttpError(409, `Port ${p} is reserved by a migration in progress towards this node`);
    if (new Set(mine).size !== mine.length) throw new HttpError(400, "The spec repeats a port");
    // plan-8: the host port of the node's router (mc-router) is not free either.
    const routerPort = this.app.routerService.reservedPort(nodeId);
    if (routerPort !== null && mine.includes(routerPort)) throw new HttpError(409, `Port ${routerPort} is used by this node's router (mc-router)`);
  }

  private completeSpec(nodeId: string, input: SpecInput, previous?: Spec): Spec {
    const game = input.ports.game ?? previous?.ports.game ?? this.allocatePort(nodeId, new Set(input.ports.extra.map((e) => e.host)));
    const candidate = {
      ...input,
      ports: { game, extra: input.ports.extra },
      rconPassword: previous?.rconPassword ?? randomToken(),
    };
    const parsed = specSchema.safeParse(candidate);
    if (!parsed.success) throw new HttpError(400, formatZodError(parsed.error));
    // Cap on the already merged spec (create, PATCH, instantiate template): each PATCH fits in the bodyLimit
    // but several large sections accumulated do not; a SyncSpecs over 4 MiB would disconnect the node in a loop.
    const tooBig = specSizeError(parsed.data);
    if (tooBig) throw new HttpError(400, tooBig);
    return parsed.data;
  }

  /** Sends the spec to the agent if the node is online (otherwise it goes in the next SyncSpecs). */
  async push(row: ServerRow): Promise<void> {
    const conn = this.app.agents.get(row.node_id);
    if (!conn) return; // it will be delivered in the next SyncSpecs
    try {
      await conn.request({ case: "applySpec", value: { server: toServerSpecMessage(row, this.app.curseforge.get()) } }, 120_000);
    } catch (e) {
      this.app.log.warn({ serverId: row.id, err: e }, "ApplySpec failed; the agent will retry it");
    }
  }

  /** Reapplies (version +1, same spec) the servers that use CurseForge. Returns how many. */
  reapplyCurseForge(): number {
    let n = 0;
    for (const row of this.app.servers.list()) {
      if (!usesCurseForge(JSON.parse(row.spec) as Spec)) continue;
      void this.push(this.app.servers.bumpVersion(row.id));
      n++;
    }
    return n;
  }

  async create(input: ServerCreateInput) {
    this.requireNode(input.nodeId);
    // plan-6: dataPath is only set by import (it is the real folder of an adopted container).
    if (input.spec.dataPath !== undefined) throw new HttpError(400, "The data folder (dataPath) is only set by importing a server");
    if (input.slug && this.app.servers.getBySlug(input.nodeId, input.slug)) {
      throw new HttpError(409, `A server with slug "${input.slug}" already exists on this node`);
    }
    const slug = input.slug ?? this.uniqueSlug(input.nodeId, slugify(input.name));
    const spec = this.completeSpec(input.nodeId, input.spec);
    this.checkPorts(input.nodeId, spec);
    this.app.routerService.checkHostname(input.nodeId, spec); // plan-8: hostname unique per node
    const row = this.app.servers.create({ nodeId: input.nodeId, name: input.name, slug, spec, desiredState: input.desiredState });
    void this.push(row);
    return toServerDto(row, { includeSecrets: true });
  }

  /** `input.spec` is a first-level merge over the stored spec: absent = leave alone, `null` = delete the section, `[]` = present and empty. */
  async patch(id: string, input: { name?: string; spec?: SpecPatch }) {
    const row = this.requireServer(id);
    let updated = row;
    let spec: Spec | null = null;
    if (input.spec) {
      const nullErr = specPatchNullError(input.spec);
      if (nullErr) throw new HttpError(400, nullErr);
      const previous = JSON.parse(row.spec) as Spec;
      const dpErr = dataPathPatchError(input.spec, previous); // plan-6
      if (dpErr) throw new HttpError(400, dpErr);
      const { rconPassword: _secret, ...previousInput } = previous;
      const merged = specInputSchema.safeParse(mergeSpecPatch(previousInput, input.spec));
      if (!merged.success) throw new HttpError(400, formatZodError(merged.error));
      const candidate = this.completeSpec(row.node_id, merged.data, previous);
      // Without real changes there is no new version: the agent would have nothing to apply.
      if (canonicalJson(candidate) !== canonicalJson(previous)) spec = candidate;
    }
    if (spec) {
      this.checkPorts(row.node_id, spec, row.id);
      this.app.routerService.checkHostname(row.node_id, spec, row.id); // plan-8
      updated = this.app.servers.updateSpec(id, spec, input.name);
      void this.push(updated);
    } else if (input.name && input.name !== row.name) {
      updated = this.app.servers.rename(id, input.name); // no spec change: not versioned
    }
    return toServerDto(updated, { includeSecrets: true });
  }

  async power(id: string, action: PowerActionName) {
    const row = this.requireServer(id);
    const conn = this.onlineConn(row.node_id);
    try {
      await conn.request({ case: "powerAction", value: { serverId: id, action: POWER[action] } }, 90_000);
    } catch (e) {
      throw agentErrorToHttp(e, "Failed to run the action");
    }
    // Only after the agent's Ack, so that panel and agent do not diverge.
    this.app.servers.setDesiredState(id, action === "start" || action === "restart" ? "running" : "stopped");
    return toServerDto(this.app.servers.get(id)!);
  }

  async command(id: string, command: string): Promise<{ output: string }> {
    const row = this.requireServer(id);
    const conn = this.onlineConn(row.node_id);
    try {
      const res = await conn.request({ case: "sendCommand", value: { serverId: id, command } }, 20_000);
      return { output: res.body.case === "commandResult" ? res.body.value.output : "" };
    } catch (e) {
      throw agentErrorToHttp(e, "Failed to send the command");
    }
  }

  async remove(id: string, deleteData: boolean) {
    const row = this.requireServer(id);
    // plan-6: the data of an imported server with dataPath is outside DATA_ROOT; the panel does not delete it.
    const dataPath = (JSON.parse(row.spec) as Spec).dataPath;
    if (deleteData && dataPath) {
      throw new HttpError(400, `This server's data is in ${dataPath}, outside DATA_ROOT: the panel does not delete it. Remove the server without data and delete the data by hand if you want`);
    }
    const conn = this.app.agents.get(row.node_id);
    if (conn) {
      try {
        await conn.request({ case: "removeServer", value: { serverId: id, deleteData } }, 120_000);
      } catch (e) {
        throw agentErrorToHttp(e, "The agent could not delete the server");
      }
    } else if (deleteData) {
      throw new HttpError(409, "The node is offline: the data cannot be deleted now. Delete without data or wait for it to come back.");
    }
    this.app.servers.delete(id);
  }
}
