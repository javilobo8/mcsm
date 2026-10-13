import type { FastifyInstance } from "fastify";
import type { RouterObserved } from "@mcsm/proto";
import { formatZodError, routerDeploymentSpecSchema, type RouterDto, type RouterObservedDto, type Spec } from "@mcsm/shared";
import { AgentError, type Body } from "../agents/hub.js";
import { AgentErrorCode } from "../agents/error-codes.js";
import { HttpError, agentErrorToHttp } from "../lib/http.js";
import { hostnameOwner, portOwner } from "./checks.js";
import { RouterRepo, rowSpec, toRouterDto } from "./repo.js";

/** Send failures that do not prevent saving: the configuration arrives on the next handshake. */
const TRANSIENT = new Set<string>([AgentErrorCode.Disconnected, AgentErrorCode.Syncing, AgentErrorCode.Timeout]);

export function observedToDto(o: RouterObserved): RouterObservedDto {
  return {
    configured: o.configured, state: o.state || "missing", containerId: o.containerId, image: o.image,
    hostPort: o.hostPort, autoscale: o.autoscale, error: o.error,
    autoscaleDownAfterMinutes: o.spec?.autoscaleDownAfterMinutes ?? 0, autoscaleAllowPlayers: [...(o.spec?.autoscaleAllowPlayers ?? [])],
  };
}

/** An agent without Plan 8 has no router: enabling it there is not saved (see `put`). */
export const ROUTER_UNSUPPORTED = "The agent on this node is out of date and does not support the router (mc-router): update it. The change was not saved.";

/**
 * mc-router of each node (spec §7 RouterService). The `router_deployments` row is the truth: after a
 * node's handshake with a row it is resent (RouterApply if enabled, RouterRemove if not) and each
 * user change is sent immediately if the node is online. A node's sends are chained
 * and each one reads the row when it goes out, so the last to reach the agent is always the current one.
 */
export class RouterService {
  private chains = new Map<string, Promise<void>>();

  constructor(private app: FastifyInstance, private repo: RouterRepo) {}

  start() {
    this.app.agents.on("attached", (nodeId: string) => {
      const conn = this.app.agents.get(nodeId);
      // After the SyncSpecs Ack (conn.ready): nothing goes out to the agent before it.
      conn?.ready.then(() => {
        if (this.repo.get(nodeId)) this.push(nodeId).catch((e) => this.app.log.warn({ nodeId, err: e }, "could not send the router to the agent"));
      }, () => { /* disconnected before syncing: the next handshake resends it */ });
    });
  }

  private requireNode(nodeId: string) {
    if (!this.app.nodes.get(nodeId)) throw new HttpError(404, "Node not found");
  }

  get(nodeId: string): RouterDto {
    this.requireNode(nodeId);
    return toRouterDto(nodeId, this.repo.get(nodeId));
  }

  /** Is the node's router enabled? */
  isEnabled(nodeId: string): boolean {
    return rowSpec(this.repo.get(nodeId)).enabled;
  }

  /**
   * Why the node cannot be deleted because of its router (null if it can): enabled, or disabled but the
   * connected agent has not yet confirmed it removed it. Offline is allowed: otherwise the node of a
   * lost machine could never be deleted; an orphaned router is removed by the agent that starts again
   * on that machine (without a router spec, or when enrolled again) or `docker rm -f mcsm-router`.
   */
  deleteBlock(nodeId: string): string | null {
    const row = this.repo.get(nodeId);
    if (rowSpec(row).enabled) return "Disable the node's router before deleting it";
    const observed = toRouterDto(nodeId, row).observed;
    if (observed?.configured && this.app.agents.get(nodeId)) return "This node's router is still being removed: wait a few seconds and try again";
    return null;
  }

  /** Host port occupied by the node's enabled router; null if it is not enabled. */
  reservedPort(nodeId: string): number | null {
    const spec = rowSpec(this.repo.get(nodeId));
    return spec.enabled ? spec.port : null;
  }

  /** Does mc-router start and stop the node's servers with a hostname on its own (router enabled with autoscale)? */
  autoscaleOn(nodeId: string): boolean {
    const spec = rowSpec(this.repo.get(nodeId));
    return spec.enabled && spec.autoscale;
  }

  /**
   * Who already uses the router hostname of `spec` on `nodeId` (null if it is free or `spec` does not use it): a server of the
   * node with the router enabled, or one being migrated to that node (Plan 7: its copy may already be there, with the
   * mc-router labels). `selfId` is the server itself.
   */
  hostnameUser(nodeId: string, spec: Spec, selfId?: string): { name: string; migrating: boolean } | null {
    if (!spec.router?.enabled) return null;
    const hostname = spec.router.hostname;
    const owner = hostnameOwner(this.app.servers.list(nodeId), hostname, selfId);
    if (owner) return { name: owner.name, migrating: false };
    const m = this.app.migrations.incoming(nodeId, selfId).find((i) => i.spec.router?.enabled && i.spec.router.hostname === hostname);
    return m ? { name: this.app.servers.get(m.serverId)?.name ?? "another server", migrating: true } : null;
  }

  /**
   * 409 if the router hostname of `spec` is already in use on the node (see `hostnameUser`). `targetName`: the node is the
   * target of a migration with that name (changes the text).
   */
  checkHostname(nodeId: string, spec: Spec, selfId?: string, targetName?: string) {
    const user = this.hostnameUser(nodeId, spec, selfId);
    if (!user) return;
    const hostname = spec.router!.hostname;
    if (user.migrating) {
      throw new HttpError(409, `Hostname “${hostname}” is reserved by “${user.name}”, which is being migrated ${targetName ? `to the target node “${targetName}”` : "to this node"}`);
    }
    throw new HttpError(409, `Hostname “${hostname}” is already used by server “${user.name}” ${targetName ? `on the target node “${targetName}”` : "on this node"}`);
  }

  async put(nodeId: string, input: unknown): Promise<RouterDto> {
    this.requireNode(nodeId);
    const parsed = routerDeploymentSpecSchema.safeParse(input ?? {});
    if (!parsed.success) throw new HttpError(400, formatZodError(parsed.error));
    const spec = parsed.data;
    if (spec.enabled) {
      const owner = portOwner(this.app.servers.list(nodeId), spec.port);
      if (owner) {
        throw new HttpError(409, `Port ${spec.port} is used by server “${owner.name}” on this node: choose another port for the router or change the server's`);
      }
      // Plan 7: the port of a server being migrated to this node (its copy will start on it).
      if (this.app.migrations.reservedPorts(nodeId).has(spec.port)) {
        throw new HttpError(409, `Port ${spec.port} is reserved by a migration in progress towards this node: choose another port for the router`);
      }
    }
    if (spec.enabled && spec.autoscale) {
      // Plan 7: with autoscale, mc-router would start here the stopped source of a migration with a hostname (the migration
      // requires it without autoscale at the start: MigrationService.plan).
      const m = this.app.migrations.openFrom(nodeId).find((o) => (JSON.parse(o.target_spec) as Spec).router?.enabled);
      if (m) {
        const name = this.app.servers.get(m.server_id)?.name ?? "A server";
        throw new HttpError(409, `“${name}” has a hostname and is being migrated from this node: enable autoscale when the migration ends (mc-router could start it here midway)`);
      }
    }
    const before = this.repo.get(nodeId);
    const row = this.repo.upsertSpec(nodeId, spec);
    this.app.events.emit("router", nodeId, toRouterDto(nodeId, row));
    try {
      await this.push(nodeId);
    } catch (e) {
      if (e instanceof AgentError && e.code === AgentErrorCode.Unsupported) {
        // An agent without a router has nothing to remove: disabling is saved. Enabling is not: it would leave a
        // reserved port, a node that cannot be deleted and a resend on every handshake for nothing.
        if (!spec.enabled) return toRouterDto(nodeId, this.repo.get(nodeId));
        if (this.repo.revert(nodeId, before, row)) this.app.events.emit("router", nodeId, toRouterDto(nodeId, this.repo.get(nodeId)));
        throw new HttpError(409, ROUTER_UNSUPPORTED);
      }
      if (!(e instanceof AgentError && TRANSIENT.has(e.code))) throw agentErrorToHttp(e, "The agent could not apply the router");
    }
    return toRouterDto(nodeId, this.repo.get(nodeId));
  }

  /** Sends the node's current configuration to the agent (if connected). Serialized per node. */
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

  /** RouterObserved from the agent (unsolicited). */
  onObserved(nodeId: string, o: RouterObserved) {
    if (!this.app.nodes.get(nodeId)) return;
    const dto = observedToDto(o);
    const before = this.repo.get(nodeId);
    if (!before && !dto.configured) return; // node without a router: nothing to store
    const row = this.repo.setObserved(nodeId, dto);
    // A router the panel does not want (e.g. after restoring the panel DB) is removed.
    if (dto.configured && !rowSpec(row).enabled) {
      this.push(nodeId).catch((e) => this.app.log.warn({ nodeId, err: e }, "could not remove the router from the agent"));
    }
    if (before?.observed !== row.observed) this.app.events.emit("router", nodeId, toRouterDto(nodeId, row));
  }
}
