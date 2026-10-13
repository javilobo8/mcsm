/** Same rule as the API (`dataRootSchema`): absolute path without `..`. Returns the error or null. */
export function validateDataRoot(p: string): string | null {
  if (!/^\/[A-Za-z0-9._/-]{1,200}$/.test(p)) return "Invalid path: it must be absolute and contain only letters, numbers, . _ - /";
  if (p.split("/").includes("..")) return "Invalid path: '..' is not allowed";
  return null;
}
