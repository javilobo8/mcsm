import { useEffect } from "react";
import { Input } from "@/components/ui/input";
import type { EditableSpec } from "@/lib/spec-edit";
import { routerSectionError, withRouter } from "@/lib/spec-edit";
import { Field, type ReportError } from "./fields";

/**
 * Entrada por hostname con el mc-router del nodo (plan-8), dentro de la pestaña Red. Activarla,
 * desactivarla o cambiar el hostname recrea el contenedor (el servidor se reinicia al aplicar).
 */
export function RouterSection({ spec, onChange, onError }: { spec: EditableSpec; onChange: (s: EditableSpec) => void; onError: ReportError }) {
  const router = spec.router ?? { enabled: false, hostname: "" };
  const error = routerSectionError(spec.router);
  useEffect(() => { onError("sf-router-hostname", error); }, [error, onError]);
  useEffect(() => () => onError("sf-router-hostname", null), [onError]);
  return (
    <div className="flex flex-col gap-3 border-t border-border pt-4">
      <div className="text-sm font-medium">Router (mc-router)</div>
      <label className="flex items-center gap-2 text-sm">
        <input id="sf-router-enabled" type="checkbox" className="size-4 accent-emerald-500" checked={router.enabled}
          onChange={(e) => onChange(withRouter(spec, { ...router, enabled: e.target.checked }))} />
        Entrar por hostname a través del router del nodo
      </label>
      <div className="max-w-sm">
        <Field id="sf-router-hostname" label="Hostname" error={error}
          hint="Los jugadores conectan a este nombre (un DNS local, p. ej. *.lan, debe apuntar al nodo) por el puerto del router (Nodos → Router). El puerto propio del servidor sigue funcionando. Cambiarlo reinicia el servidor.">
          <Input id="sf-router-hostname" value={router.hostname} placeholder="survival.lan" aria-invalid={!!error} autoCapitalize="none" spellCheck={false}
            onChange={(e) => onChange(withRouter(spec, { ...router, hostname: e.target.value.trim().toLowerCase() }))} />
        </Field>
      </div>
    </div>
  );
}
