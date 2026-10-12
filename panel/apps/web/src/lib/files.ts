import { INLINE_MAX_BYTES, editorLanguage, fileNameSchema, type FileEntryDto } from "@mcsm/shared";
import { ApiError, api, apiPath, errorMessage, reportStatus } from "./api";

export interface FileListDto { path: string; entries: FileEntryDto[]; truncated: boolean }
export interface FileContentDto { path: string; content: string; size: number }

const base = (serverId: string) => apiPath`/api/servers/${serverId}/files`;
const UPLOAD_CANCELLED = "Subida cancelada";
const q = (path: string) => `path=${encodeURIComponent(path)}`;

export const filesApi = {
  list: (serverId: string, path: string) => api.get<FileListDto>(`${base(serverId)}?${q(path)}`),
  read: (serverId: string, path: string) => api.get<FileContentDto>(`${base(serverId)}/content?${q(path)}`),
  write: (serverId: string, path: string, content: string) => api.post<void>(`${base(serverId)}/content`, { path, content }),
  mkdir: (serverId: string, path: string) => api.post<void>(`${base(serverId)}/mkdir`, { path }),
  rename: (serverId: string, from: string, to: string) => api.post<void>(`${base(serverId)}/rename`, { from, to }),
  remove: (serverId: string, path: string) => api.del<void>(`${base(serverId)}?${q(path)}`),
  downloadUrl: (serverId: string, path: string) => `${base(serverId)}/download?${q(path)}`,
};

/**
 * Sube un fichero con progreso (fetch no informa del progreso de subida). El cuerpo va como
 * application/octet-stream y el panel lo reenvía al agente en streaming.
 */
export function uploadFile(serverId: string, path: string, file: Blob, onProgress?: (sent: number, total: number) => void, signal?: AbortSignal): Promise<void> {
  const url = `${base(serverId)}/upload?${q(path)}`;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ApiError(0, UPLOAD_CANCELLED));
    const xhr = new XMLHttpRequest();
    const onAbort = () => xhr.abort();
    const done = () => signal?.removeEventListener("abort", onAbort);
    xhr.open("PUT", url);
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.upload.onprogress = (e) => onProgress?.(e.loaded, e.lengthComputable ? e.total : file.size);
    xhr.onload = () => {
      done();
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      reportStatus(xhr.status, url);
      let data: unknown = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* cuerpo no JSON */ }
      reject(new ApiError(xhr.status, errorMessage(xhr.status, xhr.statusText, data)));
    };
    // Sin xhr.timeout a propósito: una subida de varios GiB puede tardar mucho y solo se corta con la señal.
    xhr.onerror = () => { done(); reject(new ApiError(0, "Error de red: la subida se cortó")); };
    xhr.onabort = () => { done(); reject(new ApiError(0, UPLOAD_CANCELLED)); };
    signal?.addEventListener("abort", onAbort, { once: true });
    xhr.send(file);
  });
}

/** Migas de pan de una ruta: la raíz se llama "data" como en el contenedor. */
export function breadcrumbs(path: string): { name: string; path: string }[] {
  const out = [{ name: "data", path: "/" }];
  let acc = "";
  for (const seg of path.split("/").filter(Boolean)) {
    acc += `/${seg}`;
    out.push({ name: seg, path: acc });
  }
  return out;
}

/** Se abre en el editor si es texto conocido y cabe en el límite inline. */
export function canEdit(e: Pick<FileEntryDto, "name" | "dir" | "size">): boolean {
  return !e.dir && editorLanguage(e.name) !== null && e.size <= INLINE_MAX_BYTES;
}

/** Valida un nombre nuevo (carpeta o renombrado): mensaje de error o null. */
export function validateNewName(name: string, existing: readonly string[], current?: string): string | null {
  const parsed = fileNameSchema.safeParse(name);
  if (!parsed.success) return parsed.error.issues[0]?.message ?? "Nombre inválido";
  if (parsed.data !== current && existing.includes(parsed.data)) return `Ya existe «${parsed.data}» en esta carpeta`;
  return null;
}

/** Porcentaje entero de una subida (0 si el total es 0). */
export const progressPct = (sent: number, total: number): number => (total > 0 ? Math.min(100, Math.floor((sent / total) * 100)) : 0);

/** Cierto si el documento del editor es idéntico al contenido guardado (sin construir la cadena si difiere la longitud). */
export const isClean = (doc: { length: number; toString(): string }, saved: string): boolean => doc.length === saved.length && doc.toString() === saved;

/** Se puede lanzar un guardado: hay vista, hay cambios y no hay otro PUT en vuelo. */
export const canStartSave = (s: { hasView: boolean; dirty: boolean; inFlight: boolean }): boolean => s.hasView && s.dirty && !s.inFlight;
