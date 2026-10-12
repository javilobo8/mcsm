import { createContext, useContext, useEffect, useState, type ComponentProps } from "react";
import { Tabs } from "@/components/ui/tabs";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { decideTabChange } from "@/lib/tab-guard";

const GuardContext = createContext<(dirty: boolean) => void>(() => {});

/**
 * Pestañas que piden confirmación al salir de la pestaña actual mientras algún contenido
 * suyo haya registrado cambios sin guardar con `useTabGuard`. No conoce ninguna pestaña concreta.
 */
export function GuardedTabs({ defaultValue, children, ...rest }: Omit<ComponentProps<typeof Tabs>, "value" | "onValueChange" | "defaultValue"> & { defaultValue: string }) {
  const [tab, setTab] = useState(defaultValue);
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const change = (next: string) => {
    if (decideTabChange(dirty, tab, next) === "confirm") setPending(next);
    else setTab(next);
  };
  return (
    <GuardContext.Provider value={setDirty}>
      <Tabs {...rest} value={tab} onValueChange={change}>{children}</Tabs>
      <ConfirmDialog
        open={pending !== null}
        title="Cambios sin guardar"
        description="Hay cambios sin guardar en esta pestaña. Si cambias de pestaña se perderán."
        confirmLabel="Descartar y cambiar"
        onConfirm={() => { if (pending) { setDirty(false); setTab(pending); } setPending(null); }}
        onCancel={() => setPending(null)}
      />
    </GuardContext.Provider>
  );
}

/** Registra si el contenido de la pestaña montada tiene cambios sin guardar. */
export function useTabGuard(dirty: boolean): void {
  const set = useContext(GuardContext);
  useEffect(() => { set(dirty); }, [set, dirty]);
  useEffect(() => () => set(false), [set]);
}
