import { createContext, useContext, useEffect, useState, type ComponentProps } from "react";
import { Tabs } from "@/components/ui/tabs";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { decideTabChange, tabGuardText, type GuardText } from "@/lib/tab-guard";

/** Lo que registra la pestaña montada: si hay algo que perder y, opcionalmente, su texto. */
interface Guard { active: boolean; text?: GuardText }

const GuardContext = createContext<(guard: Guard) => void>(() => {});

/**
 * Pestañas que piden confirmación al salir de la pestaña actual mientras algún contenido
 * suyo haya registrado algo que perder con `useTabGuard`. No conoce ninguna pestaña concreta.
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
 * Registra si el contenido de la pestaña montada tiene algo que perder al salir (cambios sin
 * guardar, una subida en curso…) y, si quiere, el texto del diálogo de confirmación.
 */
export function useTabGuard(active: boolean, text?: GuardText): void {
  const set = useContext(GuardContext);
  const title = text?.title, description = text?.description, confirmLabel = text?.confirmLabel;
  useEffect(() => {
    set({ active, text: title !== undefined && description !== undefined && confirmLabel !== undefined ? { title, description, confirmLabel } : undefined });
  }, [set, active, title, description, confirmLabel]);
  useEffect(() => () => set({ active: false }), [set]);
}
