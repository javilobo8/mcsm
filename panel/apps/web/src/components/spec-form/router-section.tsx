import { useEffect } from "react";
import { Input } from "@/components/ui/input";
import type { EditableSpec } from "@/lib/spec-edit";
import { routerSectionError, withRouter } from "@/lib/spec-edit";
import { Field, type ReportError } from "./fields";

/**
 * Joining by hostname through the node's mc-router (plan-8), inside the Network tab. Enabling it,
 * disabling it or changing the hostname recreates the container (the server restarts when applied).
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
        Join by hostname through the node's router
      </label>
      <div className="max-w-sm">
        <Field id="sf-router-hostname" label="Hostname" error={error}
          hint="Players connect to this name (a local DNS, e.g. *.lan, must point at the node) through the router port (Nodes → Router). The server's own port keeps working. Changing it restarts the server.">
          <Input id="sf-router-hostname" value={router.hostname} placeholder="survival.lan" aria-invalid={!!error} autoCapitalize="none" spellCheck={false}
            onChange={(e) => onChange(withRouter(spec, { ...router, hostname: e.target.value.trim().toLowerCase() }))} />
        </Field>
      </div>
    </div>
  );
}
