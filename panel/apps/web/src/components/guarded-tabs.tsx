import { createContext, useContext, useEffect, useState, type ComponentProps } from "react";
import { Tabs } from "@/components/ui/tabs";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { decideTabChange, tabGuardText, type GuardText } from "@/lib/tab-guard";

/** What the mounted tab registers: whether there is something to lose and, optionally, its text. */
interface Guard { active: boolean; text?: GuardText }

const GuardContext = createContext<(guard: Guard) => void>(() => {});

/**
 * Tabs that ask for confirmation when leaving the current tab while any of its content
 * has registered something to lose with `useTabGuard`. It knows no specific tab.
 */
export function GuardedTabs({ defaultValue, children, ...rest }: Omit<ComponentProps<typeof Tabs>, "value" | "onValueChange" | "defaultValue"> & { defaultValue: string }) {
  const [tab, setTab] = useState(defaultValue);
  const [guard, setGuard] = useState<Guard>({ active: false });
  const [pending, setPending] = useState<string | null>(null);
  const change = (next: string) => {
    if (decideTabChange(guard.active, tab, next) === "confirm") setPending(next);
    else setTab(next);
  };
  const text = tabGuardText(guard.text);
  return (
    <GuardContext.Provider value={setGuard}>
      <Tabs {...rest} value={tab} onValueChange={change}>{children}</Tabs>
      <ConfirmDialog
        open={pending !== null}
        title={text.title}
        description={text.description}
        confirmLabel={text.confirmLabel}
        onConfirm={() => { if (pending) { setGuard({ active: false }); setTab(pending); } setPending(null); }}
        onCancel={() => setPending(null)}
      />
    </GuardContext.Provider>
  );
}

/**
 * Registers whether the mounted tab's content has something to lose on leaving (unsaved
 * changes, an upload in progress…) and, optionally, the text of the confirmation dialog.
 */
export function useTabGuard(active: boolean, text?: GuardText): void {
  const set = useContext(GuardContext);
  const title = text?.title, description = text?.description, confirmLabel = text?.confirmLabel;
  useEffect(() => {
    set({ active, text: title !== undefined && description !== undefined && confirmLabel !== undefined ? { title, description, confirmLabel } : undefined });
  }, [set, active, title, description, confirmLabel]);
  useEffect(() => () => set({ active: false }), [set]);
}
