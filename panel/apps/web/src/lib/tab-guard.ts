/** Cambiar de pestaña: se pide confirmación solo si hay cambios sin guardar y de verdad se sale de la pestaña. */
export function decideTabChange(dirty: boolean, current: string, next: string): "switch" | "confirm" {
  return dirty && next !== current ? "confirm" : "switch";
}

/** Texto del diálogo que confirma salir de una pestaña protegida. */
export interface GuardText { title: string; description: string; confirmLabel: string }

const DEFAULT_GUARD_TEXT: GuardText = {
  title: "Cambios sin guardar",
  description: "Hay cambios sin guardar en esta pestaña. Si cambias de pestaña se perderán.",
  confirmLabel: "Descartar y cambiar",
};

/** El texto que registró la pestaña (p. ej. "se cancelará la subida") o el genérico de cambios sin guardar. */
export function tabGuardText(custom: GuardText | null | undefined): GuardText {
  return custom ?? DEFAULT_GUARD_TEXT;
}
