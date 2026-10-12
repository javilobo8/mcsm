import { useCallback, useEffect, useRef, useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { applyError, pruneErrors } from "@/lib/form-errors";
import type { EditableSpec } from "@/lib/spec-edit";
import type { ReportError } from "./fields";
import { VersionSection } from "./version-section";
import { PropertiesSection } from "./properties-section";
import { PlayersSection } from "./players-section";
import { NetworkSection } from "./network-section";
import { ResourcesSection } from "./resources-section";
import { AdvancedSection } from "./advanced-section";

/** Errores de campo vigentes: id del campo -> mensaje. Vacío = el formulario se puede guardar/aplicar. */
export type SpecFormErrors = Readonly<Record<string, string>>;

const TABS = [
  { value: "general", label: "General" },
  { value: "version", label: "Versión y mods" },
  { value: "properties", label: "Propiedades" },
  { value: "players", label: "Jugadores" },
  { value: "network", label: "Red" },
  { value: "resources", label: "Recursos" },
  { value: "advanced", label: "Avanzado" },
] as const;
type TabValue = (typeof TABS)[number]["value"];

const FIELD_TABS: readonly [RegExp, TabValue][] = [
  [/^sf-(type|version|java|mp-|mods-|pl-)/, "version"],
  [/^sf-(prop-|props-)/, "properties"],
  [/^sf-(whitelist|ops)/, "players"],
  [/^sf-(port|extra-|proto-)/, "network"],
  [/^sf-(memory|memlimit|cpus|restart)/, "resources"],
  [/^sf-env/, "advanced"],
];

/** Pestaña a la que pertenece un campo por su id; lo desconocido es de «General» (lo pinta quien usa el formulario). */
export function tabOfField(field: string): TabValue {
  return FIELD_TABS.find(([re]) => re.test(field))?.[1] ?? "general";
}

/** Nombre visible de la sección de un campo (para decir dónde está el error). */
export function sectionOfField(field: string): string {
  const v = tabOfField(field);
  return TABS.find((t) => t.value === v)!.label;
}

/**
 * Formulario de spec por secciones (spec §8). Controlado: `value` + `onChange`. Lo usan la
 * pestaña Configuración (mode "server") y el editor de plantillas (mode "template", sin Red).
 * La sección Backups es del Plan 4 y vive en su propia pestaña.
 * `general` es el contenido propio de quien lo usa (nombre, descripción, RCON…).
 * `onError` recibe el mapa AGREGADO de errores de todas las secciones cada vez que cambia: quien lo usa
 * debe bloquear guardar/aplicar mientras no esté vacío. El propio formulario resume cuántos y dónde.
 */
export function SpecForm({ value, onChange, onError, mode, general }: {
  value: EditableSpec; onChange: (s: EditableSpec) => void; onError: (errors: SpecFormErrors) => void; mode: "server" | "template"; general: React.ReactNode;
}) {
  const [errors, setErrors] = useState<SpecFormErrors>({});
  const [tab, setTab] = useState<TabValue>("general");
  // Estable: las secciones lo usan como dependencia de efectos.
  const report = useCallback<ReportError>((field, message) => {
    setErrors((prev) => applyError(prev, field, message));
  }, []);
  // Doble seguro: tras cada render, fuera los errores de campos que ya no están en el DOM.
  useEffect(() => { setErrors((prev) => pruneErrors(prev, (f) => document.getElementById(f) !== null)); });
  const notify = useRef(onError);
  notify.current = onError;
  useEffect(() => { notify.current(errors); }, [errors]);

  const props = { spec: value, onChange, onError: report };
  const entries = Object.entries(errors);
  const perTab = new Map<TabValue, number>();
  for (const [f] of entries) perTab.set(tabOfField(f), (perTab.get(tabOfField(f)) ?? 0) + 1);
  const where = TABS.filter((t) => perTab.has(t.value));

  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as TabValue)} className="flex flex-col gap-4">
      {entries.length > 0 && (
        <div role="alert" data-testid="spec-form-errors" className="rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300">
          <p className="font-medium">
            {entries.length === 1 ? "Hay 1 error" : `Hay ${entries.length} errores`} que impiden guardar o aplicar:
          </p>
          <ul className="mt-1 list-inside list-disc">
            {where.map((t) => (
              <li key={t.value}>
                <button type="button" className="underline underline-offset-2" onClick={() => setTab(t.value)}>{t.label}</button>
                {` (${perTab.get(t.value)}): `}
                {entries.filter(([f]) => tabOfField(f) === t.value).map(([, m]) => m).join(" · ")}
              </li>
            ))}
          </ul>
        </div>
      )}
      <TabsList className="flex-wrap">
        {TABS.filter((t) => t.value !== "network" || mode === "server").map((t) => (
          <TabsTrigger key={t.value} value={t.value}>
            {t.label}
            {perTab.has(t.value) && <span className="ml-1 text-red-400" aria-label={`${perTab.get(t.value)} con error`}>({perTab.get(t.value)})</span>}
          </TabsTrigger>
        ))}
      </TabsList>
      {/* forceMount: los campos guardan su texto local; desmontarlos al cambiar de pestaña lo perdería. */}
      <TabsContent forceMount value="general" className="data-[state=inactive]:hidden">{general}</TabsContent>
      <TabsContent forceMount value="version" className="data-[state=inactive]:hidden"><VersionSection spec={value} onChange={onChange} onError={report} /></TabsContent>
      <TabsContent forceMount value="properties" className="data-[state=inactive]:hidden"><PropertiesSection {...props} /></TabsContent>
      <TabsContent forceMount value="players" className="data-[state=inactive]:hidden"><PlayersSection spec={value} onChange={onChange} onError={report} /></TabsContent>
      {mode === "server" && <TabsContent forceMount value="network" className="data-[state=inactive]:hidden"><NetworkSection {...props} /></TabsContent>}
      <TabsContent forceMount value="resources" className="data-[state=inactive]:hidden"><ResourcesSection {...props} /></TabsContent>
      <TabsContent forceMount value="advanced" className="data-[state=inactive]:hidden"><AdvancedSection {...props} /></TabsContent>
    </Tabs>
  );
}
