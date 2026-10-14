import { useEffect, useSyncExternalStore } from "react";

// Open state of the docs search dialog, shared by the navbar, the docs layout and the ⌘K shortcut.
let open = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const searchDialog = {
  set(next: boolean) {
    if (open === next) return;
    open = next;
    emit();
  },
  open() {
    searchDialog.set(true);
  },
};

export function useSearchDialogOpen(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => open,
  );
}

/** ⌘K / Ctrl+K toggles the search dialog anywhere on the site. */
export function useSearchShortcut(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        searchDialog.set(!open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/** "⌘K" on Apple platforms, "Ctrl K" elsewhere. */
export function shortcutLabel(): string {
  const platform = typeof navigator === "undefined" ? "" : navigator.platform || navigator.userAgent;
  return /mac|iphone|ipad|ipod/i.test(platform) ? "⌘K" : "Ctrl K";
}
