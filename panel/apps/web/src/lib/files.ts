import { INLINE_MAX_BYTES, editorLanguage, fileNameSchema, type FileEntryDto } from "@mcsm/shared";
import { ApiError, api, apiPath, errorMessage, reportStatus } from "./api";
import type { GuardText } from "./tab-guard";

export interface FileListDto { path: string; entries: FileEntryDto[]; truncated: boolean }
export interface FileContentDto { path: string; content: string; size: number }

const base = (serverId: string) => apiPath`/api/servers/${serverId}/files`;
const UPLOAD_CANCELLED = "Upload cancelled";
const q = (path: string) => `path=${encodeURIComponent(path)}`;

/** Above this the panel does not drain the body of a rejected upload and the browser sees a network cut. */
const BIG_UPLOAD_BYTES = 8 * 1024 * 1024;

/** Message of a cut upload: with a large file, the likely causes (N2/m-n of Plan 5). */
export function uploadCutMessage(size: number): string {
  if (size <= BIG_UPLOAD_BYTES) return "Network error: the upload was cut off";
  return "The upload was cut off. The server may be busy (backup, restore or migration) or the file may exceed the node's maximum (UPLOAD_MAX_BYTES, 4 GiB by default). Check History and try again.";
}

export const filesApi = {
  list: (serverId: string, path: string) => api.get<FileListDto>(`${base(serverId)}?${q(path)}`),
  stat: (serverId: string, path: string) => api.get<FileEntryDto>(`${base(serverId)}/stat?${q(path)}`),
  read: (serverId: string, path: string) => api.get<FileContentDto>(`${base(serverId)}/content?${q(path)}`),
  write: (serverId: string, path: string, content: string) => api.post<void>(`${base(serverId)}/content`, { path, content }),
  mkdir: (serverId: string, path: string) => api.post<void>(`${base(serverId)}/mkdir`, { path }),
  rename: (serverId: string, from: string, to: string) => api.post<void>(`${base(serverId)}/rename`, { from, to }),
  remove: (serverId: string, path: string) => api.del<void>(`${base(serverId)}?${q(path)}`),
  uploadCheck: (serverId: string) => api.get<void>(apiPath`/api/servers/${serverId}/files/upload-check`),
  downloadUrl: (serverId: string, path: string) => `${base(serverId)}/download?${q(path)}`,
};

/**
 * Uploads a file with progress (fetch does not report upload progress). The body goes as
 * application/octet-stream and the panel forwards it to the agent as a stream.
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
      try { data = JSON.parse(xhr.responseText); } catch { /* non-JSON body */ }
      reject(new ApiError(xhr.status, errorMessage(xhr.status, xhr.statusText, data)));
    };
    // No xhr.timeout on purpose: an upload of several GiB can take a long time and is only cut by the signal.
    xhr.onerror = () => { done(); reject(new ApiError(0, uploadCutMessage(file.size))); };
    xhr.onabort = () => { done(); reject(new ApiError(0, UPLOAD_CANCELLED)); };
    signal?.addEventListener("abort", onAbort, { once: true });
    xhr.send(file);
  });
}

/**
 * What is lost when leaving the Files tab (to another server tab, another page or
 * closing the browser): the editor's unsaved changes and/or an upload in progress, which is
 * cancelled on leaving. null if there is nothing to protect.
 */
export function leaveWarning({ dirty, uploading, file }: { dirty: boolean; uploading: boolean; file: string | null }): GuardText | null {
  const what = file ?? "the file";
  if (dirty && uploading) {
    return {
      title: "Unsaved changes and upload in progress",
      description: `There are unsaved changes in ${what} and an upload in progress. If you leave, the changes will be lost and the upload will be cancelled.`,
      confirmLabel: "Leave and cancel",
    };
  }
  if (dirty) return { title: "Unsaved changes", description: `There are unsaved changes in ${what}. If you leave, they will be lost.`, confirmLabel: "Leave and discard" };
  if (uploading) return { title: "Upload in progress", description: "There is an upload in progress. If you leave, the upload will be cancelled.", confirmLabel: "Leave and cancel the upload" };
  return null;
}

/**
 * Check before a download. The browser does it on its own (link with `download`)
 * and, if it fails before the data, it does not show the error to the page: it shows “download failed” without
 * the reason. With the result of a `stat` just before, returns the message to show (node
 * offline, the file no longer exists, it is now a folder…) or null to start it.
 */
export function downloadBlocker(check: { entry: FileEntryDto } | { error: unknown }): string | null {
  if ("error" in check) return check.error instanceof ApiError ? check.error.message : "Could not check the file before downloading it";
  if (check.entry.dir) return "It is a folder: it cannot be downloaded";
  return null;
}

/** Starts the browser download, like a click on a link with `download`. */
export function startDownload(url: string, name: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Breadcrumbs of a path: the root is called "data" as in the container. */
export function breadcrumbs(path: string): { name: string; path: string }[] {
  const out = [{ name: "data", path: "/" }];
  let acc = "";
  for (const seg of path.split("/").filter(Boolean)) {
    acc += `/${seg}`;
    out.push({ name: seg, path: acc });
  }
  return out;
}

/** It opens in the editor if it is known text and fits within the inline limit. */
export function canEdit(e: Pick<FileEntryDto, "name" | "dir" | "size">): boolean {
  return !e.dir && editorLanguage(e.name) !== null && e.size <= INLINE_MAX_BYTES;
}

/** Validates a new name (folder or rename): error message or null. */
export function validateNewName(name: string, existing: readonly string[], current?: string): string | null {
  const parsed = fileNameSchema.safeParse(name);
  if (!parsed.success) return parsed.error.issues[0]?.message ?? "Invalid name";
  if (parsed.data !== current && existing.includes(parsed.data)) return `“${parsed.data}” already exists in this folder`;
  return null;
}

/** Whole-number percentage of an upload (0 if the total is 0). */
export const progressPct = (sent: number, total: number): number => (total > 0 ? Math.min(100, Math.floor((sent / total) * 100)) : 0);

/** True if the editor's document is identical to the saved content (without building the string if the length differs). */
export const isClean = (doc: { length: number; toString(): string }, saved: string): boolean => doc.length === saved.length && doc.toString() === saved;

/** A save can be started: there is a view, there are changes and no other PUT in flight. */
export const canStartSave = (s: { hasView: boolean; dirty: boolean; inFlight: boolean }): boolean => s.hasView && s.dirty && !s.inFlight;

/** Folders first and then by name (case-insensitive). Does not mutate the input. */
export function sortEntries<T extends Pick<FileEntryDto, "name" | "dir">>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** What opening an entry does: navigate to the folder, open the editor or (if not editable) download only. */
export function entryOpenKind(e: Pick<FileEntryDto, "name" | "dir" | "size">): "dir" | "edit" | "download" {
  if (e.dir) return "dir";
  return canEdit(e) ? "edit" : "download";
}

/** Uploaded names that already exist in the folder (without repeats). */
export function uploadClashes(names: readonly string[], existing: readonly string[]): string[] {
  const have = new Set(existing);
  return [...new Set(names.filter((n) => have.has(n)))];
}

/** Ctrl/Cmd+S without other modifiers. */
export function isSaveShortcut(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">): boolean {
  return e.key.toLowerCase() === "s" && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey;
}
