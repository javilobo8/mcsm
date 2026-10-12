/** Cambiar de pestaña: se pide confirmación solo si hay cambios sin guardar y de verdad se sale de la pestaña. */
export function decideTabChange(dirty: boolean, current: string, next: string): "switch" | "confirm" {
  return dirty && next !== current ? "confirm" : "switch";
}
