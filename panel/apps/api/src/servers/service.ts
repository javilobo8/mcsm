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

// HttpError vive en lib/http.ts; se re-exporta para el código que lo importa desde aquí.
export { HttpError };

const POWER: Record<PowerActionName, PowerActionType> = {
  start: PowerActionType.START, stop: PowerActionType.STOP, restart: PowerActionType.RESTART, kill: PowerActionType.KILL,
};

export class ServersService {
  constructor(private app: FastifyInstance) {}

  private requireNode(nodeId: string) {
    const node = this.app.nodes.get(nodeId);
    if (!node) throw new HttpError(404, "Nodo no encontrado");
    return node;
  }

  private requireServer(id: string): ServerRow {
    const row = this.app.servers.get(id);
    if (!row) throw new HttpError(404, "Servidor no encontrado");
    return row;
  }

  private onlineConn(nodeId: string) {
    const conn = this.app.agents.get(nodeId);
    if (!conn) throw new HttpError(409, "El nodo está desconectado");
    return conn;
  }

  allocatePort(nodeId: string, exclude = new Set<number>()): number {
    const used = this.app.servers.usedGamePorts(nodeId);
    for (const p of this.app.migrations.reservedPorts(nodeId)) used.add(p); // plan-7: migraciones hacia el nodo
    const { from, to } = this.app.settings.gamePortRange();
    const routerPort = this.app.routerService.reservedPort(nodeId); // plan-8: el puerto del router no se reparte
    if (routerPort !== null) used.add(routerPort);
    for (let p = from; p <= to; p++) if (!used.has(p) && !exclude.has(p)) return p;
    throw new HttpError(409, `No quedan puertos libres entre ${from} y ${to} en este nodo`);
  }

  /** Sufija `-2`, `-3`… respetando el máximo de 40 caracteres. */
  private uniqueSlug(nodeId: string, base: string): string {
    if (!this.app.servers.getBySlug(nodeId, base)) return base;
    for (let n = 2; ; n++) {
      const suffix = `-${n}`;
      const candidate = base.slice(0, 40 - suffix.length).replace(/-+$/g, "") + suffix;
      if (!this.app.servers.getBySlug(nodeId, candidate)) return candidate;
    }
  }

  /** Puertos de la spec libres en el nodo (lo usa también la importación, plan-6). */
  checkPorts(nodeId: string, spec: Spec, selfId?: string) {
    const reserved = this.app.migrations.reservedPorts(nodeId, selfId); // plan-7: migraciones hacia el nodo
    const used = new Set<number>();
    for (const r of this.app.servers.list(nodeId)) {
      if (r.id === selfId) continue;
      const s = JSON.parse(r.spec) as Spec;
      used.add(s.ports.game);
      for (const e of s.ports.extra) used.add(e.host);
    }
    const mine = [spec.ports.game, ...spec.ports.extra.map((e) => e.host)];
    for (const p of mine) if (used.has(p)) throw new HttpError(409, `El puerto ${p} ya lo usa otro servidor de este nodo`);
    for (const p of mine) if (reserved.has(p)) throw new HttpError(409, `El puerto ${p} lo reserva una migración en curso hacia este nodo`);
    if (new Set(mine).size !== mine.length) throw new HttpError(400, "La spec repite un puerto");
    // plan-8: el puerto del host del router (mc-router) del nodo tampoco está libre.
    const routerPort = this.app.routerService.reservedPort(nodeId);
    if (routerPort !== null && mine.includes(routerPort)) throw new HttpError(409, `El puerto ${routerPort} lo usa el router (mc-router) de este nodo`);
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
    // Tope de la spec ya fusionada (crear, PATCH, instanciar plantilla): cada PATCH cabe en el bodyLimit
    // pero varias secciones grandes acumuladas no; un SyncSpecs de más de 4 MiB desconectaría el nodo en bucle.
    const tooBig = specSizeError(parsed.data);
    if (tooBig) throw new HttpError(400, tooBig);
    return parsed.data;
  }

  /** Envía la spec al agente si el nodo está conectado (si no, irá en el próximo SyncSpecs). */
  async push(row: ServerRow): Promise<void> {
    const conn = this.app.agents.get(row.node_id);
    if (!conn) return; // se entregará en el próximo SyncSpecs
    try {
      await conn.request({ case: "applySpec", value: { server: toServerSpecMessage(row, this.app.curseforge.get()) } }, 120_000);
    } catch (e) {
      this.app.log.warn({ serverId: row.id, err: e }, "ApplySpec sin éxito; el agente lo reintentará");
    }
  }

  /** Reaplica (versión +1, misma spec) los servidores que usan CurseForge. Devuelve cuántos. */
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
    // plan-6: dataPath solo lo fija la importación (es la carpeta real de un contenedor adoptado).
    if (input.spec.dataPath !== undefined) throw new HttpError(400, "La carpeta de datos (dataPath) solo la fija la importación de un servidor");
    if (input.slug && this.app.servers.getBySlug(input.nodeId, input.slug)) {
      throw new HttpError(409, `Ya existe un servidor con slug "${input.slug}" en este nodo`);
    }
    const slug = input.slug ?? this.uniqueSlug(input.nodeId, slugify(input.name));
    const spec = this.completeSpec(input.nodeId, input.spec);
    this.checkPorts(input.nodeId, spec);
    this.app.routerService.checkHostname(input.nodeId, spec); // plan-8: hostname único por nodo
    const row = this.app.servers.create({ nodeId: input.nodeId, name: input.name, slug, spec, desiredState: input.desiredState });
    void this.push(row);
    return toServerDto(row, { includeSecrets: true });
  }

  /** `input.spec` es un merge de primer nivel sobre la spec guardada: ausente = no tocar, `null` = borrar la sección, `[]` = presente vacía. */
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
      // Sin cambios reales no se versiona: el agente no tendría nada que aplicar.
      if (canonicalJson(candidate) !== canonicalJson(previous)) spec = candidate;
    }
    if (spec) {
      this.checkPorts(row.node_id, spec, row.id);
      this.app.routerService.checkHostname(row.node_id, spec, row.id); // plan-8
      updated = this.app.servers.updateSpec(id, spec, input.name);
      void this.push(updated);
    } else if (input.name && input.name !== row.name) {
      updated = this.app.servers.rename(id, input.name); // sin cambio de spec: no se versiona
    }
    return toServerDto(updated, { includeSecrets: true });
  }

  async power(id: string, action: PowerActionName) {
    const row = this.requireServer(id);
    const conn = this.onlineConn(row.node_id);
    try {
      await conn.request({ case: "powerAction", value: { serverId: id, action: POWER[action] } }, 90_000);
    } catch (e) {
      throw agentErrorToHttp(e, "Fallo al ejecutar la acción");
    }
    // Solo tras el Ack del agente, para que panel y agente no diverjan.
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
      throw agentErrorToHttp(e, "Fallo al enviar el comando");
    }
  }

  async remove(id: string, deleteData: boolean) {
    const row = this.requireServer(id);
    // plan-6: los datos de un importado con dataPath están fuera de DATA_ROOT; el panel no los borra.
    const dataPath = (JSON.parse(row.spec) as Spec).dataPath;
    if (deleteData && dataPath) {
      throw new HttpError(400, `Los datos de este servidor están en ${dataPath}, fuera de DATA_ROOT: el panel no los borra. Elimínalo sin datos y bórralos a mano si quieres`);
    }
    const conn = this.app.agents.get(row.node_id);
    if (conn) {
      try {
        await conn.request({ case: "removeServer", value: { serverId: id, deleteData } }, 120_000);
      } catch (e) {
        throw agentErrorToHttp(e, "El agente no pudo eliminar el servidor");
      }
    } else if (deleteData) {
      throw new HttpError(409, "El nodo está desconectado: no se pueden borrar los datos ahora. Borra sin datos o espera a que vuelva.");
    }
    this.app.servers.delete(id);
  }
}
