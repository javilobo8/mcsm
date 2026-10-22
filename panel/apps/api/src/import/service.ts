import type { FastifyInstance } from "fastify";
import type { ImportCandidate } from "@mcsm/proto";
import {
  dataPathsOverlap, formatZodError, sameSpecInput, specInputSchema, specSchema, specSizeError, usesCurseForge,
  type ImportAdoptInput, type ImportCandidateDto, type ImportedFrom, type Spec, type SpecPatch,
} from "@mcsm/shared";
import { AgentError, type AgentConn } from "../agents/hub.js";
import { AgentErrorCode } from "../agents/error-codes.js";
import { HttpError, agentErrorToHttp } from "../lib/http.js";
import { nowIso } from "../lib/time.js";
import { randomToken } from "../lib/tokens.js";
import { parseImportedFrom, toServerDto, toServerSpecMessage, type ServerDto } from "../servers/repo.js";
import { COMPOSE_PROJECT, COMPOSE_SERVICE, proposeImport, toCandidateDto, type ImportProposal } from "./propose.js";

const SCAN_TIMEOUT_MS = 30_000;
const ADOPT_TIMEOUT_MS = 60_000;

/**
 * Spec sections the browser reviews on import: those of the form (the web's FORM_KEYS).
 * The rest of the body is ignored: dataPath and the RCON password come from the container (never from the
 * browser) and the rest (backups…) is not part of the import.
 */
const EDITABLE_KEYS = [
  "imageTag", "type", "version", "memory", "properties", "env", "resources", "restartPolicy", "ports",
  "modpack", "mods", "plugins", "whitelist", "ops",
  "build", // plan-10
] as const;

function editableOnly(spec: SpecPatch): SpecPatch {
  const out: SpecPatch = {};
  for (const k of EDITABLE_KEYS) if (Object.hasOwn(spec, k)) out[k] = spec[k];
  return out;
}

interface Scanned { candidate: ImportCandidate; proposal: ImportProposal }

/** Import of existing servers (spec §6.7, §7 ImportService). */
export class ImportService {
  constructor(private app: FastifyInstance) {}

  private conn(nodeId: string): AgentConn {
    if (!this.app.nodes.get(nodeId)) throw new HttpError(404, "Node not found");
    const conn = this.app.agents.get(nodeId);
    if (!conn) throw new HttpError(409, "The node is offline");
    return conn;
  }

  /** Containers that are already a server imported by the panel, on any node: they are not adopted twice. */
  private importedContainers(): Set<string> {
    const ids = new Set<string>();
    for (const r of this.app.servers.list()) {
      const id = parseImportedFrom(r)?.containerId;
      if (id) ids.add(id);
    }
    return ids;
  }

  /** ImportScan + proposal for each candidate not yet imported. */
  private async scan(nodeId: string, conn: AgentConn): Promise<Scanned[]> {
    let res;
    try {
      res = await conn.request({ case: "importScan", value: {} }, SCAN_TIMEOUT_MS);
    } catch (e) {
      throw agentErrorToHttp(e, "The agent could not list the containers");
    }
    if (res.body.case !== "importScanResult") throw new HttpError(502, "Unexpected response from the agent");
    const { candidates, dataRoot } = res.body.value;
    const imported = this.importedContainers();
    const ctx = {
      dataRoot,
      takenSlugs: new Set(this.app.servers.list(nodeId).map((r) => r.slug)),
      curseforgeConfigured: this.app.curseforge.get() !== null,
    };
    return candidates.filter((c) => !imported.has(c.containerId)).map((c) => ({ candidate: c, proposal: proposeImport(c, ctx) }));
  }

  async candidates(nodeId: string): Promise<ImportCandidateDto[]> {
    const conn = this.conn(nodeId);
    return (await this.scan(nodeId, conn)).map(({ candidate, proposal }) => toCandidateDto(candidate, proposal));
  }

  /**
   * Adopts a candidate. Scans again (does not trust what the browser sent): dataPath, the RCON
   * password and the CurseForge key come from the container. Without applyNow it requires the proposal unchanged
   * (the v1 spec describes the container that keeps running); with applyNow it goes up to v2 after the Ack.
   */
  async adopt(nodeId: string, input: ImportAdoptInput): Promise<ServerDto> {
    const conn = this.conn(nodeId);
    const found = (await this.scan(nodeId, conn)).find((s) => s.candidate.containerId === input.containerId);
    // From here until the row is created there is no await: another adoption of the same container cannot sneak in
    // between the check and the INSERT (the scan filter was computed before yielding the turn).
    if (!found || this.importedContainers().has(input.containerId)) {
      throw new HttpError(404, "That container can no longer be imported: it does not exist, the panel already manages it or it was already imported");
    }
    const { candidate: c, proposal: p } = found;
    if (p.blockers.length > 0) throw new HttpError(409, p.blockers[0]!);

    const parsed = specInputSchema.safeParse(editableOnly(input.spec));
    if (!parsed.success) throw new HttpError(400, formatZodError(parsed.error));
    if (!input.applyNow && (p.specError !== null || !sameSpecInput(p.spec, parsed.data))) {
      throw new HttpError(409, "The configuration is not the container's: adopting it without stopping it requires the proposal unchanged. Use “Adopt and apply” (recreates the container) or undo the changes");
    }

    const slug = input.slug ?? p.slug;
    if (p.slugLocked && slug !== p.slug) throw new HttpError(400, `The slug must be “${p.slug}”: the data is already in DATA_ROOT/${p.slug}/data`);
    if (this.app.servers.getBySlug(nodeId, slug)) throw new HttpError(409, `A server with slug "${slug}" already exists on this node`);
    if (p.dataPath) {
      for (const r of this.app.servers.list(nodeId)) {
        const other = (JSON.parse(r.spec) as Spec).dataPath;
        if (other && dataPathsOverlap(other, p.dataPath)) throw new HttpError(409, `Server “${r.name}” already uses that data folder (${other})`);
      }
    }
    const game = parsed.data.ports.game ?? p.spec.ports.game;
    // "auto" (the browser asks for a free RCON port) is resolved like on create; a number is kept; absent = not published.
    const rcon = parsed.data.ports.rcon === "auto"
      ? this.app.serversService.allocatePort(nodeId, new Set([game ?? 0, ...parsed.data.ports.extra.map((e) => e.host)]))
      : parsed.data.ports.rcon;
    const full = specSchema.safeParse({
      ...parsed.data,
      ports: { game, extra: parsed.data.ports.extra, ...(rcon === undefined ? {} : { rcon }) },
      rconPassword: p.rconPassword ?? randomToken(),
      ...(p.dataPath ? { dataPath: p.dataPath } : {}),
    });
    if (!full.success) throw new HttpError(400, formatZodError(full.error));
    const tooBig = specSizeError(full.data);
    if (tooBig) throw new HttpError(400, tooBig);
    this.app.serversService.checkPorts(nodeId, full.data);

    // The container's CurseForge key travels with the adoption if there is none in Settings, and is saved
    // there only if the agent confirms the adoption (m10: with a 504 it is not known whether it accepted; the user
    // puts it in Settings). Without re-applying the other servers (recreating them because one was imported would be surprising):
    // they will receive it on their next change.
    const storedKey = this.app.curseforge.get();
    const containerKey = storedKey === null && p.curseforgeApiKey && usesCurseForge(full.data) ? p.curseforgeApiKey : null;
    const keepContainerKey = () => { if (containerKey && this.app.curseforge.get() === null) this.app.curseforge.set(containerKey); };

    const created = this.app.servers.create({ nodeId, name: input.name, slug, spec: full.data, desiredState: p.desiredState });
    const from: ImportedFrom = {
      containerId: c.containerId, containerName: c.name, specVersion: created.spec_version, importedAt: nowIso(),
      composeProject: c.labels[COMPOSE_PROJECT] ?? "", composeService: c.labels[COMPOSE_SERVICE] ?? "",
    };
    let row = this.app.servers.setImportedFrom(created.id, from);
    try {
      await conn.request({ case: "importAdopt", value: { server: toServerSpecMessage(row, storedKey ?? containerKey) } }, ADOPT_TIMEOUT_MS);
    } catch (e) {
      if (e instanceof AgentError && (e.code === AgentErrorCode.Timeout || e.code === AgentErrorCode.Disconnected)) {
        // The agent may have adopted it: deleting the row would make the next SyncSpecs remove the server
        // and delete the original container. It is kept: on reconnect, its spec (with adopt) completes the
        // adoption with the same checks. With applyNow it goes up to v2 right away: the agent recreates on adopting.
        if (input.applyNow) void this.app.serversService.push(this.app.servers.bumpVersion(row.id));
        this.app.log.warn({ nodeId, serverId: row.id, code: e.code }, "ImportAdopt unconfirmed; the imported server is kept");
        const cfNote = containerKey ? " It uses CurseForge and the container's API key has not been saved: configure it in Settings before applying changes" : "";
        throw new HttpError(504, `The agent did not confirm the adoption in time. The server stays imported and the adoption will complete when the node responds: check its status in a few seconds.${cfNote}`);
      }
      this.app.servers.delete(row.id);
      throw agentErrorToHttp(e, "The agent could not adopt the container");
    }
    keepContainerKey();
    if (input.applyNow) {
      row = this.app.servers.bumpVersion(row.id);
      void this.app.serversService.push(row);
    }
    // No secrets: the RCON password is the container's (the server page shows it on demand).
    return toServerDto(row);
  }
}
