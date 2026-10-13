import { validateEnv, type EditableSpec } from "@/lib/spec-edit";
import { KvField, type ReportError } from "./fields";

/** "Advanced" section: free environment variables of the itzg image (they win over what is generated). */
export function AdvancedSection({ spec, onChange, onError }: { spec: EditableSpec; onChange: (s: EditableSpec) => void; onError: ReportError }) {
  return (
    <KvField id="sf-env" label="Extra environment variables (KEY=value per line)" value={spec.env} rows={10} onError={onError} validate={validateEnv}
      placeholder={"USE_AIKAR_FLAGS=true\nENABLE_AUTOPAUSE=false\nMODRINTH_DOWNLOAD_DEPENDENCIES=required"}
      hint="They win over what the other sections generate. EULA, TYPE, VERSION, MEMORY, RCON_*, SERVER_PORT, CUSTOM_SERVER_PROPERTIES and CF_API_KEY cannot be set (the CurseForge API key is configured separately). With the operators or the whitelist managed in Players, OPS, OPS_FILE, WHITELIST, WHITELIST_FILE and ENABLE_WHITELIST cannot be set either."
      onChange={(env) => onChange({ ...spec, env })} />
  );
}
