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
 * Secciones de la spec que el navegador revisa al importar: las del formulario (FORM_KEYS de la web).
 * Lo demás del cuerpo se ignora: dataPath y la contraseña RCON salen del contenedor (nunca del
 * navegador) y el resto (copias…) no forma parte de la importación.
 */
const EDITABLE_KEYS = [
  "imageTag", "type", "version", "memory", "properties", "env", "resources", "restartPolicy", "ports",
  "modpack", "mods", "plugins", "whitelist", "ops",
] as const;

function editableOnly(spec: SpecPatch): SpecPatch {
  const out: SpecPatch = {};
  for (const k of EDITABLE_KEYS) if (Object.hasOwn(spec, k)) out[k] = spec[k];
  return out;
}

interface Scanned { candidate: ImportCandidate; proposal: ImportProposal }

/** Importación de servidores existentes (spec §6.7, §7 ImportService). */
export class ImportService {
  constructor(private app: FastifyInstance) {}

  private conn(nodeId: string): AgentConn {
    if (!this.app.nodes.get(nodeId)) throw new HttpError(404, "Nodo no encontrado");
    const conn = this.app.agents.get(nodeId);
    if (!conn) throw new HttpError(409, "El nodo está desconectado");
    return conn;
  }

  /** Contenedores que ya son un servidor importado del panel, en cualquier nodo: no se adoptan dos veces. */
  private importedContainers(): Set<string> {
    const ids = new Set<string>();
    for (const r of this.app.servers.list()) {
      const id = parseImportedFrom(r)?.containerId;
      if (id) ids.add(id);
    }
    return ids;
  }

  /** ImportScan + propuesta de cada candidato aún no importado. */
  private async scan(nodeId: string, conn: AgentConn): Promise<Scanned[]> {
    let res;
    try {
      res = await conn.request({ case: "importScan", value: {} }, SCAN_TIMEOUT_MS);
    } catch (e) {
      throw agentErrorToHttp(e, "El agente no pudo listar los contenedores");
    }
    if (res.body.case !== "importScanResult") throw new HttpError(502, "Respuesta inesperada del agente");
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
   * Adopta un candidato. Vuelve a escanear (no se fía de lo que mandó el navegador): dataPath, la
   * contraseña RCON y la key de CurseForge salen del contenedor. Sin applyNow exige la propuesta sin
   * cambios (la spec v1 describe el contenedor que sigue en marcha); con applyNow sube a v2 tras el Ack.
   */
  async adopt(nodeId: string, input: ImportAdoptInput): Promise<ServerDto> {
    const conn = this.conn(nodeId);
    const found = (await this.scan(nodeId, conn)).find((s) => s.candidate.containerId === input.containerId);
    // Desde aquí hasta crear la fila no hay await: otra adopción del mismo contenedor no puede colarse
    // entre la comprobación y el INSERT (el filtro de scan se calculó antes de ceder el turno).
    if (!found || this.importedContainers().has(input.containerId)) {
      throw new HttpError(404, "Ese contenedor ya no se puede importar: no existe, ya lo gestiona el panel o ya se importó");
    }
    const { candidate: c, proposal: p } = found;
    if (p.blockers.length > 0) throw new HttpError(409, p.blockers[0]!);

    const parsed = specInputSchema.safeParse(editableOnly(input.spec));
    if (!parsed.success) throw new HttpError(400, formatZodError(parsed.error));
    if (!input.applyNow && (p.specError !== null || !sameSpecInput(p.spec, parsed.data))) {
      throw new HttpError(409, "La configuración no es la del contenedor: adoptarlo sin pararlo exige la propuesta sin cambios. Usa «Adoptar y aplicar» (recrea el contenedor) o deshaz los cambios");
    }

    const slug = input.slug ?? p.slug;
    if (p.slugLocked && slug !== p.slug) throw new HttpError(400, `El slug tiene que ser «${p.slug}»: los datos ya están en DATA_ROOT/${p.slug}/data`);
    if (this.app.servers.getBySlug(nodeId, slug)) throw new HttpError(409, `Ya existe un servidor con slug "${slug}" en este nodo`);
    if (p.dataPath) {
      for (const r of this.app.servers.list(nodeId)) {
        const other = (JSON.parse(r.spec) as Spec).dataPath;
        if (other && dataPathsOverlap(other, p.dataPath)) throw new HttpError(409, `El servidor «${r.name}» ya usa esa carpeta de datos (${other})`);
      }
    }
    const full = specSchema.safeParse({
      ...parsed.data,
      ports: { game: parsed.data.ports.game ?? p.spec.ports.game, extra: parsed.data.ports.extra },
      rconPassword: p.rconPassword ?? randomToken(),
      ...(p.dataPath ? { dataPath: p.dataPath } : {}),
    });
    if (!full.success) throw new HttpError(400, formatZodError(full.error));
    const tooBig = specSizeError(full.data);
    if (tooBig) throw new HttpError(400, tooBig);
    this.app.serversService.checkPorts(nodeId, full.data);

    // La key de CurseForge del contenedor viaja con la adopción si no hay ninguna en Ajustes, y se guarda
    // allí solo si el agente pudo adoptarlo (o quizá lo hizo). Sin reaplicar a los demás servidores
    // (recrearlos por importar uno sorprendería): la recibirán en su próximo cambio.
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
        // Puede que el agente lo adoptara: borrar la fila haría que el próximo SyncSpecs retirara el servidor
        // y borrara el contenedor original. Se conserva: al reconectar, su spec (con adopt) completa la
        // adopción con las mismas comprobaciones. Con applyNow sube ya a v2: el agente recrea al adoptar.
        keepContainerKey();
        if (input.applyNow) void this.app.serversService.push(this.app.servers.bumpVersion(row.id));
        this.app.log.warn({ nodeId, serverId: row.id, code: e.code }, "ImportAdopt sin confirmar; el servidor importado se conserva");
        throw new HttpError(504, "El agente no confirmó la adopción a tiempo. El servidor queda importado y la adopción se completará cuando el nodo responda: revisa su estado en unos segundos");
      }
      this.app.servers.delete(row.id);
      throw agentErrorToHttp(e, "El agente no pudo adoptar el contenedor");
    }
    keepContainerKey();
    if (input.applyNow) {
      row = this.app.servers.bumpVersion(row.id);
      void this.app.serversService.push(row);
    }
    // Sin secretos: la contraseña RCON es la del contenedor (la página del servidor la enseña bajo demanda).
    return toServerDto(row);
  }
}
