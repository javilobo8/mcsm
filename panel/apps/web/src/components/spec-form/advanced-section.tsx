import { validateEnv, type EditableSpec } from "@/lib/spec-edit";
import { KvField, type ReportError } from "./fields";

/** Sección "Avanzado": variables de entorno libres de la imagen itzg (ganan sobre lo generado). */
export function AdvancedSection({ spec, onChange, onError }: { spec: EditableSpec; onChange: (s: EditableSpec) => void; onError: ReportError }) {
  return (
    <KvField id="sf-env" label="Variables de entorno extra (CLAVE=valor por línea)" value={spec.env} rows={10} onError={onError} validate={validateEnv}
      placeholder={"USE_AIKAR_FLAGS=true\nENABLE_AUTOPAUSE=false\nMODRINTH_DOWNLOAD_DEPENDENCIES=required"}
      hint="Ganan sobre lo que generan las demás secciones. No se pueden fijar EULA, TYPE, VERSION, MEMORY, RCON_*, SERVER_PORT, CUSTOM_SERVER_PROPERTIES ni CF_API_KEY (la API key de CurseForge se configura aparte)."
      onChange={(env) => onChange({ ...spec, env })} />
  );
}
