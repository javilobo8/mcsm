import type { FastifyInstance } from "fastify";
import type { RouterObserved } from "@mcsm/proto";
import { formatZodError, routerDeploymentSpecSchema, type RouterDto, type RouterObservedDto, type Spec } from "@mcsm/shared";
import { AgentError, type Body } from "../agents/hub.js";
import { AgentErrorCode } from "../agents/error-codes.js";
import { HttpError, agentErrorToHttp } from "../lib/http.js";
import { hostnameOwner, portOwner } from "./checks.js";
import { RouterRepo, rowSpec, toRouterDto } from "./repo.js";

/** Fallos de envío que no impiden guardar: la configuración llega en el próximo handshake. */
const TRANSIENT = new Set<string>([AgentErrorCode.Disconnected, AgentErrorCode.Syncing, AgentErrorCode.Timeout]);

export function observedToDto(o: RouterObserved): RouterObservedDto {
  return {
    configured: o.configured, state: o.state || "missing", containerId: o.containerId, image: o.image,
    hostPort: o.hostPort, autoscale: o.autoscale, error: o.error,
    autoscaleDownAfterMinutes: o.spec?.autoscaleDownAfterMinutes ?? 0, autoscaleAllowPlayers: [...(o.spec?.autoscaleAllowPlayers ?? [])],
  };
}

/**
 * mc-router de cada nodo (spec §7 RouterService). La fila de `router_deployments` es la verdad: tras el
 * handshake de un nodo con fila se le reenvía (RouterApply si está activo, RouterRemove si no) y cada
 * cambio del usuario se envía al momento si el nodo está conectado. Los envíos de un nodo van en
 * cadena y cada uno lee la fila al salir, así que el último en llegar al agente es siempre el vigente.
 */
export class RouterService {
  private chains = new Map<string, Promise<void>>();

  constructor(private app: FastifyInstance, private repo: RouterRepo) {}

  start() {
    this.app.agents.on("attached", (nodeId: string) => {
      const conn = this.app.agents.get(nodeId);
      // Tras el Ack de SyncSpecs (conn.ready): nada sale al agente antes.
      conn?.ready.then(() => {
        if (this.repo.get(nodeId)) this.push(nodeId).catch((e) => this.app.log.warn({ nodeId, err: e }, "no se pudo enviar el router al agente"));
      }, () => { /* desconectado antes de sincronizar: el próximo handshake lo reenvía */ });
    });
  }

  private requireNode(nodeId: string) {
    if (!this.app.nodes.get(nodeId)) throw new HttpError(404, "Nodo no encontrado");
  }

  get(nodeId: string): RouterDto {
    this.requireNode(nodeId);
    return toRouterDto(nodeId, this.repo.get(nodeId));
  }

  /** ¿Está activo el router del nodo? */
  isEnabled(nodeId: string): boolean {
    return rowSpec(this.repo.get(nodeId)).enabled;
  }

  /** Puerto del host que ocupa el router activo del nodo; null si no está activo. */
  reservedPort(nodeId: string): number | null {
    const spec = rowSpec(this.repo.get(nodeId));
    return spec.enabled ? spec.port : null;
  }

  /** 409 si el hostname del router de `spec` ya lo usa otro servidor del nodo (con el router activo). */
  checkHostname(nodeId: string, spec: Spec, selfId?: string) {
    if (!spec.router?.enabled) return;
    const owner = hostnameOwner(this.app.servers.list(nodeId), spec.router.hostname, selfId);
    if (owner) throw new HttpError(409, `El hostname «${spec.router.hostname}» ya lo usa el servidor «${owner.name}» de este nodo`);
  }

  async put(nodeId: string, input: unknown): Promise<RouterDto> {
    this.requireNode(nodeId);
    const parsed = routerDeploymentSpecSchema.safeParse(input ?? {});
    if (!parsed.success) throw new HttpError(400, formatZodError(parsed.error));
    const spec = parsed.data;
    if (spec.enabled) {
      const owner = portOwner(this.app.servers.list(nodeId), spec.port);
      if (owner) {
        throw new HttpError(409, `El puerto ${spec.port} lo usa el servidor «${owner.name}» de este nodo: elige otro puerto para el router o cambia el del servidor`);
      }
    }
    const row = this.repo.upsertSpec(nodeId, spec);
    this.app.events.emit("router", nodeId, toRouterDto(nodeId, row));
    try {
      await this.push(nodeId);
    } catch (e) {
      if (!(e instanceof AgentError && TRANSIENT.has(e.code))) throw agentErrorToHttp(e, "El agente no pudo aplicar el router");
    }
    return toRouterDto(nodeId, this.repo.get(nodeId));
  }

  /** Envía al agente la configuración vigente del nodo (si está conectado). Serializado por nodo. */
  push(nodeId: string): Promise<void> {
    const prev = this.chains.get(nodeId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(async () => {
      const conn = this.app.agents.get(nodeId);
      if (!conn) return;
      const spec = rowSpec(this.repo.get(nodeId));
      const body: Body = spec.enabled
        ? { case: "routerApply", value: { spec: {
          hostPort: spec.port, autoscale: spec.autoscale, autoscaleDownAfterMinutes: spec.autoscaleDownAfterMinutes,
          autoscaleAllowPlayers: spec.autoscaleAllowPlayers,
        } } }
        : { case: "routerRemove", value: {} };
      await conn.request(body, 30_000);
    });
    this.chains.set(nodeId, next);
    next.then(() => this.release(nodeId, next), () => this.release(nodeId, next));
    return next;
  }

  private release(nodeId: string, p: Promise<void>) {
    if (this.chains.get(nodeId) === p) this.chains.delete(nodeId);
  }

  /** RouterObserved del agente (no solicitado). */
  onObserved(nodeId: string, o: RouterObserved) {
    if (!this.app.nodes.get(nodeId)) return;
    const dto = observedToDto(o);
    const before = this.repo.get(nodeId);
    if (!before && !dto.configured) return; // nodo sin router: nada que guardar
    const row = this.repo.setObserved(nodeId, dto);
    // Un router que el panel no quiere (p. ej. tras restaurar la BD del panel) se retira.
    if (dto.configured && !rowSpec(row).enabled) {
      this.push(nodeId).catch((e) => this.app.log.warn({ nodeId, err: e }, "no se pudo retirar el router del agente"));
    }
    if (before?.observed !== row.observed) this.app.events.emit("router", nodeId, toRouterDto(nodeId, row));
  }
}
