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

/** Un agente sin el Plan 8 no tiene router: activarlo ahí no se guarda (ver `put`). */
export const ROUTER_UNSUPPORTED = "El agente de este nodo está desactualizado y no admite el router (mc-router): actualízalo. No se ha guardado el cambio.";

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

  /**
   * Por qué no se puede borrar el nodo por su router (null si se puede): activo, o desactivado pero el
   * agente conectado aún no ha confirmado que lo retiró. Desconectado se permite: si no, el nodo de una
   * máquina perdida no se podría borrar nunca; un router huérfano lo retira el agente que vuelva a
   * arrancar en esa máquina (sin spec de router, o al darse de alta de nuevo) o `docker rm -f mcsm-router`.
   */
  deleteBlock(nodeId: string): string | null {
    const row = this.repo.get(nodeId);
    if (rowSpec(row).enabled) return "Desactiva el router del nodo antes de borrarlo";
    const observed = toRouterDto(nodeId, row).observed;
    if (observed?.configured && this.app.agents.get(nodeId)) return "El router de este nodo todavía se está retirando: espera unos segundos y vuelve a intentarlo";
    return null;
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
    const before = this.repo.get(nodeId);
    const row = this.repo.upsertSpec(nodeId, spec);
    this.app.events.emit("router", nodeId, toRouterDto(nodeId, row));
    try {
      await this.push(nodeId);
    } catch (e) {
      if (e instanceof AgentError && e.code === AgentErrorCode.Unsupported) {
        // Un agente sin router no tiene nada que retirar: desactivar se guarda. Activar no: quedaría un
        // puerto reservado, un nodo sin poder borrarse y un reenvío en cada handshake para nada.
        if (!spec.enabled) return toRouterDto(nodeId, this.repo.get(nodeId));
        if (this.repo.revert(nodeId, before, row)) this.app.events.emit("router", nodeId, toRouterDto(nodeId, this.repo.get(nodeId)));
        throw new HttpError(409, ROUTER_UNSUPPORTED);
      }
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
