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

/** Current field errors: field id -> message. Empty = the form can be saved/applied. */
export type SpecFormErrors = Readonly<Record<string, string>>;

const TABS = [
  { value: "general", label: "General" },
  { value: "version", label: "Version and mods" },
  { value: "properties", label: "Properties" },
  { value: "players", label: "Players" },
  { value: "network", label: "Network" },
  { value: "resources", label: "Resources" },
  { value: "advanced", label: "Advanced" },
] as const;
type TabValue = (typeof TABS)[number]["value"];

const FIELD_TABS: readonly [RegExp, TabValue][] = [
  [/^sf-(type|version|java|mp-|mods-|pl-)/, "version"],
  [/^sf-(prop-|props-)/, "properties"],
  [/^sf-(whitelist|ops)/, "players"],
  [/^sf-(port|extra-|proto-|router-)/, "network"],
  [/^sf-(memory|memlimit|cpus|restart)/, "resources"],
  [/^sf-env/, "advanced"],
];

/** Tab a field belongs to by its id; anything unknown belongs to “General” (rendered by whoever uses the form). */
export function tabOfField(field: string): TabValue {
  return FIELD_TABS.find(([re]) => re.test(field))?.[1] ?? "general";
}

/** Visible name of a field's section (to say where the error is). */
export function sectionOfField(field: string): string {
  const v = tabOfField(field);
  return TABS.find((t) => t.value === v)!.label;
}

/**
 * Spec form by sections (spec §8). Controlled: `value` + `onChange`. Used by the
 * Configuration tab (mode "server") and the template editor (mode "template", without Network).
 * The Backups section belongs to Plan 4 and lives in its own tab.
 * `general` is the content specific to whoever uses it (name, description, RCON…).
 * `onError` receives the AGGREGATED error map of all sections every time it changes: whoever uses it
 * must block saving/applying while it is not empty. The form itself summarizes how many and where.
 * `routerHidden` (plan-8): replaces the router section of the Network tab with that text (import).
 */
export function SpecForm({ value, onChange, onError, mode, general, routerHidden }: {
  value: EditableSpec; onChange: (s: EditableSpec) => void; onError: (errors: SpecFormErrors) => void; mode: "server" | "template"; general: React.ReactNode;
  routerHidden?: string;
}) {
  const [errors, setErrors] = useState<SpecFormErrors>({});
  const [tab, setTab] = useState<TabValue>("general");
  // Stable: the sections use it as an effect dependency.
  const report = useCallback<ReportError>((field, message) => {
    setErrors((prev) => applyError(prev, field, message));
  }, []);
  // Double safety: after every render, drop the errors of fields that are no longer in the DOM.
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
        <div role="alert" data-testid="spec-form-errors" className="rounded-md border border-redstone/40 bg-redstone/10 p-3 text-sm text-bad">
          <p className="font-medium">
            {entries.length === 1 ? "There is 1 error" : `There are ${entries.length} errors`} that prevent saving or applying:
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
      <TabsList variant="pill" className="flex-wrap">
        {TABS.filter((t) => t.value !== "network" || mode === "server").map((t) => (
          <TabsTrigger key={t.value} value={t.value}>
            {t.label}
            {perTab.has(t.value) && <span className="ml-1 text-bad" aria-label={`${perTab.get(t.value)} with errors`}>({perTab.get(t.value)})</span>}
          </TabsTrigger>
        ))}
      </TabsList>
      {/* forceMount: the fields keep their local text; unmounting them when switching tabs would lose it. */}
      <TabsContent forceMount value="general" className="data-[state=inactive]:hidden">{general}</TabsContent>
      <TabsContent forceMount value="version" className="data-[state=inactive]:hidden"><VersionSection spec={value} onChange={onChange} onError={report} /></TabsContent>
      <TabsContent forceMount value="properties" className="data-[state=inactive]:hidden"><PropertiesSection {...props} /></TabsContent>
      <TabsContent forceMount value="players" className="data-[state=inactive]:hidden"><PlayersSection spec={value} onChange={onChange} onError={report} /></TabsContent>
      {mode === "server" && <TabsContent forceMount value="network" className="data-[state=inactive]:hidden"><NetworkSection {...props} routerHidden={routerHidden} /></TabsContent>}
      <TabsContent forceMount value="resources" className="data-[state=inactive]:hidden"><ResourcesSection {...props} /></TabsContent>
      <TabsContent forceMount value="advanced" className="data-[state=inactive]:hidden"><AdvancedSection {...props} /></TabsContent>
    </Tabs>
  );
}
