import { canonicalJson, sameSpecInput, type ImportCandidateDto } from "@mcsm/shared";
import type { ServerDto } from "./api";
import type { EditableSpec } from "./spec-edit";
import type { GuardText } from "./tab-guard";

/** What the user reviews before adopting a container (Nodes → Import). */
export interface ReviewState { name: string; slug: string; spec: EditableSpec }

export function initialReview(c: ImportCandidateDto): ReviewState {
  return { name: c.proposal.name, slug: c.proposal.slug, spec: c.proposal.spec };
}

/**
 * Plan 8: the import does not adopt the router (the panel discards it: an adopted server does not have the mc-router labels
 * until it is recreated). The review does not show it and here it does not count: it is enabled later, in Configuration → Network.
 */
function withoutRouter(spec: EditableSpec): EditableSpec {
  const { router: _router, ...rest } = spec;
  return rest;
}

/** Is the reviewed spec the one deduced from the container, and is it valid? Only then is it adopted without stopping. */
export function isPristine(c: ImportCandidateDto, spec: EditableSpec): boolean {
  return c.proposal.specError === null && sameSpecInput(withoutRouter(c.proposal.spec), withoutRouter(spec));
}

/** Is there anything to lose if the review is left? (name, slug or spec different from the proposal). */
export function reviewDirty(c: ImportCandidateDto, r: ReviewState): boolean {
  const init = initialReview(c);
  return r.name !== init.name || r.slug !== init.slug || canonicalJson(withoutRouter(r.spec)) !== canonicalJson(withoutRouter(init.spec));
}

/** Plan 8: what the review's Network tab says in place of the router section. */
export const IMPORT_ROUTER_NOTE = "Router (mc-router): the hostname is enabled after importing the server, in its Configuration → Network.";

const REVIEW_LEAVE_WARNING: GuardText = {
  title: "Review not finished",
  description: "You have changed this container's configuration and have not imported it yet. If you leave, the changes will be lost.",
  confirmLabel: "Leave and discard",
};

/** What to protect when leaving the review (another page, back to the list or closing the browser). null if nothing. */
export function reviewLeaveWarning(dirty: boolean): GuardText | null {
  return dirty ? REVIEW_LEAVE_WARNING : null;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * Why it cannot be adopted (null = it can). `applyNow`: “Adopt and apply” (recreates right away);
 * otherwise, “Adopt without stopping”, which requires the proposal unchanged. `specError`: validateSpec of the review.
 */
export function adoptBlock(
  c: ImportCandidateDto, r: ReviewState,
  o: { fieldErrors: Readonly<Record<string, string>>; specError: string | null; applyNow: boolean },
): string | null {
  if (c.blockers.length > 0) return c.blockers[0]!;
  if (!r.name.trim()) return "Enter a name";
  if (!SLUG_RE.test(r.slug)) return "Invalid slug: lowercase letters, numbers and hyphens (max. 40)";
  const n = Object.keys(o.fieldErrors).length;
  if (n > 0) return `Fix ${n} ${n === 1 ? "field with an error" : "fields with errors"}`;
  if (o.specError) return o.specError;
  if (!o.applyNow && !isPristine(c, r.spec)) {
    return c.proposal.specError
      ? "The container's configuration is not valid as is: fix it and use “Adopt and apply”"
      : "You have changed the configuration: use “Adopt and apply” (recreates the container) or undo the changes";
  }
  return null;
}

/** Body of POST /api/nodes/:id/import. dataPath does not travel (the panel takes it from the container), nor the fixed slug, nor the router. */
export function adoptRequest(c: ImportCandidateDto, r: ReviewState, applyNow: boolean) {
  const { dataPath: _fromContainer, ...spec } = withoutRouter(r.spec);
  return { containerId: c.containerId, name: r.name.trim(), ...(c.proposal.slugLocked ? {} : { slug: r.slug }), spec, applyNow };
}

/** The server is still in the original container that was imported (not yet recreated). */
export function isAdopted(s: Pick<ServerDto, "importedFrom" | "observed">): boolean {
  return !!s.importedFrom && !!s.observed && s.observed.containerId === s.importedFrom.containerId;
}

/** Notices for the server page header. */
export function importNotices(s: Pick<ServerDto, "importedFrom" | "observed" | "slug" | "spec">): string[] {
  const out: string[] = [];
  const from = s.importedFrom;
  if (from && isAdopted(s)) {
    out.push(`Imported from “${from.containerName}”: it stays in its original container until the first “Save and apply”, which will recreate it as mcsm-${s.slug} (brief stop; the world is not touched) and delete the original container.`);
    if (from.composeProject) {
      out.push(`Comes from Docker Compose (project “${from.composeProject}”, service “${from.composeService}”): remove that service from the compose file before applying changes, or Compose will create it again.`);
    }
  }
  if (s.spec.dataPath) {
    out.push(`The data is in ${s.spec.dataPath}, outside DATA_ROOT: this server has no backups or file browser, and cannot be migrated to another node.`);
  }
  return out;
}

/**
 * What changes on an imported server's page (I3, m5). With dataPath the agent cannot see the data:
 * the Backups, Files and Migrate tabs are replaced by an explanation and the delete-world checkbox is
 * disabled (the panel does not delete it). If it is still in the original container, deleting removes it.
 */
export interface ServerImportView {
  /** Explanation in place of the Backups tab, or null if it works. */
  backups: string | null;
  /** Explanation in place of the Files tab, or null if it works. */
  files: string | null;
  /** Why “also delete the world” cannot be checked, or null. */
  deleteData: string | null;
  /** Explanation in place of the Migrate tab (the panel would answer 409), or null if it can be migrated. */
  migrate: string | null;
  /** Notice to confirm a migration: removing the source deletes the original imported container. Or null. */
  retire: string | null;
  /** Text of the delete dialog. */
  deleteDescription: string;
}

const DELETE_DESCRIPTION = "The server will be removed from the panel and its container will be deleted.";

export function serverImportView(s: Pick<ServerDto, "importedFrom" | "observed" | "slug" | "spec">): ServerImportView {
  const dataPath = s.spec.dataPath;
  const outside = dataPath
    ? `This server's data is in ${dataPath}, outside DATA_ROOT, and the agent cannot see it`
    : null;
  const howTo = `To use them, delete it without deleting data, move that folder to DATA_ROOT/${s.slug}/data and import it again.`;
  const from = s.importedFrom;
  let deleteDescription = DELETE_DESCRIPTION;
  let retire: string | null = null;
  if (from) {
    const compose = from.composeProject ? ` If it was created by Docker Compose (project “${from.composeProject}”), also remove that service from the compose file.` : "";
    // Removing the source (MigrateRetire) deletes the container just like deletion does: if it is still the original, that one.
    const composeRetire = from.composeProject ? ` If it was created by Docker Compose (project “${from.composeProject}”), also remove that service from the compose file, or Compose will create it again on the source.` : "";
    if (isAdopted(s)) {
      deleteDescription = `The server will be removed from the panel and its container will be deleted, which is still the original “${from.containerName}” you imported: it also ceases to exist outside the panel.${compose}`;
      retire = `It is still in the original container “${from.containerName}” you imported: when it finishes, it will be deleted when the server is removed from the source and will cease to exist outside the panel too.${composeRetire}`;
    } else if (!s.observed?.containerId) {
      deleteDescription = `The server will be removed from the panel and its container will be deleted. If it has not been recreated yet, that container is the original “${from.containerName}” you imported.${compose}`;
      retire = `When it finishes, removing the source will delete its container. If it has not been recreated yet, that container is the original “${from.containerName}” you imported.${composeRetire}`;
    }
  }
  return {
    backups: outside && `${outside}: it has no backups. ${howTo}`,
    files: outside && `${outside}: it has no file browser. ${howTo}`,
    deleteData: dataPath ? `The data is in ${dataPath}, outside DATA_ROOT: the panel does not delete it (delete it by hand if you want).` : null,
    retire,
    migrate: outside && `${outside}: it cannot be migrated to another node. To migrate it, delete it without deleting data, move that folder to DATA_ROOT/${s.slug}/data and import it again.`,
    deleteDescription,
  };
}

const STATES: Record<string, string> = {
  running: "Running", exited: "Stopped", created: "Created", restarting: "Restarting", paused: "Paused", dead: "Dead",
};
export const candidateStateLabel = (state: string): string => STATES[state] ?? state;
