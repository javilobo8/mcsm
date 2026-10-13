/** Switching tabs: confirmation is requested only if there are unsaved changes and the tab is really being left. */
export function decideTabChange(dirty: boolean, current: string, next: string): "switch" | "confirm" {
  return dirty && next !== current ? "confirm" : "switch";
}

/** Text of the dialog that confirms leaving a protected tab. */
export interface GuardText { title: string; description: string; confirmLabel: string }

const DEFAULT_GUARD_TEXT: GuardText = {
  title: "Unsaved changes",
  description: "There are unsaved changes in this tab. If you switch tabs they will be lost.",
  confirmLabel: "Discard and switch",
};

/** The text the tab registered (e.g. "the upload will be cancelled") or the generic unsaved-changes one. */
export function tabGuardText(custom: GuardText | null | undefined): GuardText {
  return custom ?? DEFAULT_GUARD_TEXT;
}
