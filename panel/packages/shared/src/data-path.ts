import { z } from "zod";

/**
 * `dataPath` (plan-6, spec §6.7): carpeta del host montada en /data de un servidor importado cuando no
 * es <DATA_ROOT>/<slug>/data. Mismas reglas que agent/internal/spec/adopt.go (ValidateDataPath); los
 * casos de proto/fixtures/data-path-cases.json se prueban en los dos lados. El agente corre como root
 * y el entrypoint de itzg hace chown de /data: nada de zonas del sistema.
 */
export const DATA_PATH_MAX_BYTES = 1024;
const SEGMENT_RE = /^[A-Za-z0-9._@+ -]+$/;
export const DENIED_DATA_PATHS = [
  "/bin", "/boot", "/dev", "/etc", "/lib", "/lib32", "/lib64", "/libx32", "/proc", "/run",
  "/sbin", "/sys", "/usr", "/var/lib/docker", "/var/run",
] as const;

/** ¿`child` es `parent` o cuelga de él? Rutas absolutas limpias; se compara por tramos. */
export function pathWithin(child: string, parent: string): boolean {
  if (parent === "/") return child.startsWith("/");
  return child === parent || child.startsWith(`${parent}/`);
}

export const dataPathsOverlap = (a: string, b: string): boolean => pathWithin(a, b) || pathWithin(b, a);

const encoder = new TextEncoder();

/** Por qué no vale `p` como dataPath, o null. No conoce DATA_ROOT (eso lo comprueban el agente y la importación). */
export function dataPathError(p: string): string | null {
  if (encoder.encode(p).length > DATA_PATH_MAX_BYTES) return `Ruta demasiado larga (máx. ${DATA_PATH_MAX_BYTES} bytes)`;
  if (!p.startsWith("/")) return "Debe ser una ruta absoluta";
  const segs = p.slice(1).split("/");
  if (segs.length < 2) return "Ruta demasiado general: indica al menos dos niveles";
  for (const s of segs) {
    if (s === "" || s === "." || s === "..") return "Ruta no normalizada: sin //, «.» ni «..», y sin / al final";
    if (!SEGMENT_RE.test(s)) return "Caracteres no admitidos: letras y números ASCII, espacio y . _ @ + -";
  }
  const denied = DENIED_DATA_PATHS.find((d) => pathWithin(p, d));
  return denied ? `Está en una zona del sistema (${denied}): no se monta` : null;
}

export const dataPathSchema = z.string().superRefine((p, ctx) => {
  const e = dataPathError(p);
  if (e) ctx.addIssue({ code: "custom", message: `Carpeta de datos: ${e}` });
});

/** dataPath y copias programadas no conviven: el agente no ve esa carpeta (solo monta DATA_ROOT). Igual que validateImport en Go. */
export function dataPathCheck(s: { dataPath?: string | undefined; backups?: { enabled: boolean } | undefined }, ctx: z.RefinementCtx) {
  if (s.dataPath && s.backups?.enabled) {
    ctx.addIssue({ code: "custom", path: ["backups", "enabled"], message: "Las copias programadas no están disponibles: los datos de este servidor están fuera de DATA_ROOT" });
  }
}

/**
 * PATCH de spec: dataPath solo lo fija la importación (es la carpeta real del contenedor adoptado). El
 * PATCH solo puede reenviarlo igual; cambiarlo o quitarlo (null) es 400: quitarlo recrearía el servidor
 * sobre <DATA_ROOT>/<slug>/data, vacía, y el mundo «desaparecería». `null` sin dataPath previo no cambia
 * nada. Mensaje del 400 o null.
 */
export function dataPathPatchError(patch: Record<string, unknown>, previous: { dataPath?: string | undefined }): string | null {
  if (!Object.hasOwn(patch, "dataPath")) return null;
  const v = patch.dataPath;
  if (v === previous.dataPath || (v === null && previous.dataPath === undefined)) return null;
  return "La carpeta de datos (dataPath) solo la fija la importación de un servidor: no se puede cambiar ni quitar por aquí. Para llevar los datos a DATA_ROOT, elimina el servidor sin borrar datos, mueve la carpeta a DATA_ROOT/<slug>/data y vuelve a importarlo";
}
