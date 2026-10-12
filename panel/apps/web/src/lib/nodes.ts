/** Misma regla que la API (`dataRootSchema`): ruta absoluta sin `..`. Devuelve el error o null. */
export function validateDataRoot(p: string): string | null {
  if (!/^\/[A-Za-z0-9._/-]{1,200}$/.test(p)) return "Ruta inválida: debe ser absoluta y solo con letras, números, . _ - /";
  if (p.split("/").includes("..")) return "Ruta inválida: no se admite '..'";
  return null;
}
