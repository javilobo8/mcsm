import { canonicalJson, sameSpecInput, type ImportCandidateDto } from "@mcsm/shared";
import type { ServerDto } from "./api";
import type { EditableSpec } from "./spec-edit";
import type { GuardText } from "./tab-guard";

/** Lo que el usuario revisa antes de adoptar un contenedor (Nodos → Importar). */
export interface ReviewState { name: string; slug: string; spec: EditableSpec }

export function initialReview(c: ImportCandidateDto): ReviewState {
  return { name: c.proposal.name, slug: c.proposal.slug, spec: c.proposal.spec };
}

/** ¿La spec revisada es la deducida del contenedor, y esta es válida? Solo entonces se adopta sin parar. */
export function isPristine(c: ImportCandidateDto, spec: EditableSpec): boolean {
  return c.proposal.specError === null && sameSpecInput(c.proposal.spec, spec);
}

/** ¿Hay algo que perder si se sale de la revisión? (nombre, slug o spec distintos de la propuesta). */
export function reviewDirty(c: ImportCandidateDto, r: ReviewState): boolean {
  const init = initialReview(c);
  return r.name !== init.name || r.slug !== init.slug || canonicalJson(r.spec) !== canonicalJson(init.spec);
}

const REVIEW_LEAVE_WARNING: GuardText = {
  title: "Revisión sin terminar",
  description: "Has cambiado la configuración de este contenedor y aún no lo has importado. Si sales, se perderán los cambios.",
  confirmLabel: "Salir y descartar",
};

/** Qué proteger al salir de la revisión (otra página, volver a la lista o cerrar el navegador). null si nada. */
export function reviewLeaveWarning(dirty: boolean): GuardText | null {
  return dirty ? REVIEW_LEAVE_WARNING : null;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * Por qué no se puede adoptar (null = se puede). `applyNow`: «Adoptar y aplicar» (recrea enseguida);
 * si no, «Adoptar sin parar», que exige la propuesta sin cambios. `specError`: validateSpec de la revisión.
 */
export function adoptBlock(
  c: ImportCandidateDto, r: ReviewState,
  o: { fieldErrors: Readonly<Record<string, string>>; specError: string | null; applyNow: boolean },
): string | null {
  if (c.blockers.length > 0) return c.blockers[0]!;
  if (!r.name.trim()) return "Escribe un nombre";
  if (!SLUG_RE.test(r.slug)) return "Slug inválido: minúsculas, números y guiones (máx. 40)";
  const n = Object.keys(o.fieldErrors).length;
  if (n > 0) return `Corrige ${n} ${n === 1 ? "campo con error" : "campos con error"}`;
  if (o.specError) return o.specError;
  if (!o.applyNow && !isPristine(c, r.spec)) {
    return c.proposal.specError
      ? "La configuración del contenedor no es válida tal cual: corrígela y usa «Adoptar y aplicar»"
      : "Has cambiado la configuración: usa «Adoptar y aplicar» (recrea el contenedor) o deshaz los cambios";
  }
  return null;
}

/** Cuerpo de POST /api/nodes/:id/import. dataPath no viaja (el panel lo saca del contenedor) ni el slug fijo. */
export function adoptRequest(c: ImportCandidateDto, r: ReviewState, applyNow: boolean) {
  const { dataPath: _fromContainer, ...spec } = r.spec;
  return { containerId: c.containerId, name: r.name.trim(), ...(c.proposal.slugLocked ? {} : { slug: r.slug }), spec, applyNow };
}

/** El servidor sigue en el contenedor original que se importó (aún sin recrear). */
export function isAdopted(s: Pick<ServerDto, "importedFrom" | "observed">): boolean {
  return !!s.importedFrom && !!s.observed && s.observed.containerId === s.importedFrom.containerId;
}

/** Avisos para la cabecera de la página del servidor. */
export function importNotices(s: Pick<ServerDto, "importedFrom" | "observed" | "slug" | "spec">): string[] {
  const out: string[] = [];
  const from = s.importedFrom;
  if (from && isAdopted(s)) {
    out.push(`Importado de «${from.containerName}»: sigue en su contenedor original hasta el primer «Guardar y aplicar», que lo recreará como mcsm-${s.slug} (parada breve; el mundo no se toca) y borrará el contenedor original.`);
    if (from.composeProject) {
      out.push(`Viene de Docker Compose (proyecto «${from.composeProject}», servicio «${from.composeService}»): quita ese servicio del compose antes de aplicar cambios, o Compose volverá a crearlo.`);
    }
  }
  if (s.spec.dataPath) {
    out.push(`Los datos están en ${s.spec.dataPath}, fuera de DATA_ROOT: este servidor no tiene copias de seguridad ni navegador de archivos, y no se puede migrar a otro nodo.`);
  }
  return out;
}

/**
 * Qué cambia en la página de un servidor importado (I3, m5). Con dataPath el agente no ve los datos:
 * las pestañas Backups, Archivos y Migrar se sustituyen por una explicación y la casilla de borrar el mundo se
 * desactiva (el panel no lo borra). Si aún sigue en el contenedor original, el borrado lo elimina.
 */
export interface ServerImportView {
  /** Explicación en lugar de la pestaña Backups, o null si funciona. */
  backups: string | null;
  /** Explicación en lugar de la pestaña Archivos, o null si funciona. */
  files: string | null;
  /** Por qué no se puede marcar «borrar también el mundo», o null. */
  deleteData: string | null;
  /** Explicación en lugar de la pestaña Migrar (el panel respondería 409), o null si se puede migrar. */
  migrate: string | null;
  /** Texto del diálogo de borrado. */
  deleteDescription: string;
}

const DELETE_DESCRIPTION = "El servidor se quitará del panel y su contenedor se eliminará.";

export function serverImportView(s: Pick<ServerDto, "importedFrom" | "observed" | "slug" | "spec">): ServerImportView {
  const dataPath = s.spec.dataPath;
  const outside = dataPath
    ? `Los datos de este servidor están en ${dataPath}, fuera de DATA_ROOT, y el agente no los ve`
    : null;
  const howTo = `Para tenerlos, elimínalo sin borrar datos, mueve esa carpeta a DATA_ROOT/${s.slug}/data y vuelve a importarlo.`;
  const from = s.importedFrom;
  let deleteDescription = DELETE_DESCRIPTION;
  if (from) {
    const compose = from.composeProject ? ` Si lo creó Docker Compose (proyecto «${from.composeProject}»), quita también ese servicio del compose.` : "";
    if (isAdopted(s)) {
      deleteDescription = `El servidor se quitará del panel y se eliminará su contenedor, que todavía es el original «${from.containerName}» que importaste: deja de existir también fuera del panel.${compose}`;
    } else if (!s.observed?.containerId) {
      deleteDescription = `El servidor se quitará del panel y su contenedor se eliminará. Si aún no se ha recreado, ese contenedor es el original «${from.containerName}» que importaste.${compose}`;
    }
  }
  return {
    backups: outside && `${outside}: no tiene copias de seguridad. ${howTo}`,
    files: outside && `${outside}: no tiene navegador de archivos. ${howTo}`,
    deleteData: dataPath ? `Los datos están en ${dataPath}, fuera de DATA_ROOT: el panel no los borra (bórralos a mano si quieres).` : null,
    migrate: outside && `${outside}: no se puede migrar a otro nodo. Para migrarlo, elimínalo sin borrar datos, mueve esa carpeta a DATA_ROOT/${s.slug}/data y vuelve a importarlo.`,
    deleteDescription,
  };
}

const STATES: Record<string, string> = {
  running: "En marcha", exited: "Parado", created: "Creado", restarting: "Reiniciando", paused: "En pausa", dead: "Muerto",
};
export const candidateStateLabel = (state: string): string => STATES[state] ?? state;
