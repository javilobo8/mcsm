import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { playersEnvErrors, type EditableSpec } from "@/lib/spec-edit";
import { ListField, type ReportError } from "./fields";

/**
 * Sección "Jugadores": whitelist y operadores (WHITELIST/ENABLE_WHITELIST y OPS).
 * Ausente no es vacío: abrir la sección no crea nada; la lista pasa a gestionarse al editarla, y
 * «Dejar de gestionar» la elimina de la spec (el agente deja de tocar el fichero).
 */
export function PlayersSection({ spec, onChange, onError }: { spec: EditableSpec; onChange: (s: EditableSpec) => void; onError?: ReportError }) {
  const wl = spec.whitelist;
  const ops = spec.ops;
  // Solo "Dejar de gestionar" remonta el textarea (para vaciar su texto); el alta no, o se perdería el foco.
  const [resets, setResets] = useState({ wl: 0, ops: 0 });
  // OPS/WHITELIST/ENABLE_WHITELIST… en Avanzado ganarían sobre estas listas: error de esta sección (bloquea aplicar).
  const envErr = playersEnvErrors(spec);
  const opsEnvErr = envErr["sf-ops-env"];
  const wlEnvErr = envErr["sf-whitelist-env"];
  useEffect(() => { onError?.("sf-ops-env", opsEnvErr); }, [opsEnvErr, onError]);
  useEffect(() => { onError?.("sf-whitelist-env", wlEnvErr); }, [wlEnvErr, onError]);
  useEffect(() => () => { onError?.("sf-ops-env", null); onError?.("sf-whitelist-env", null); }, [onError]);
  const clear = (key: "whitelist" | "ops", ids: string[]) => {
    for (const id of ids) onError?.(id, null);
    setResets((r) => ({ ...r, [key === "ops" ? "ops" : "wl"]: r[key === "ops" ? "ops" : "wl"] + 1 }));
    const { [key]: _drop, ...rest } = spec;
    onChange(rest as EditableSpec);
  };
  return (
    <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
      <div className="flex flex-col gap-3">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" checked={wl?.enabled ?? false}
            onChange={(e) => onChange({ ...spec, whitelist: { enabled: e.target.checked, players: wl?.players ?? [] } })} />
          Activar whitelist (solo pueden entrar los de la lista)
        </label>
        <ListField key={`wl-${resets.wl}`} id="sf-whitelist" label="Jugadores de la whitelist" kind="player" value={wl?.players} rows={6} onError={onError} placeholder={"Lobo\nSteve"}
          hint="Nombre de Java o UUID, uno por línea. Al arrancar, whitelist.json queda igual que esta lista: lo añadido con /whitelist add se pierde (pon EXISTING_WHITELIST_FILE=MERGE en Avanzado si prefieres sumar)."
          onChange={(players) => onChange({ ...spec, whitelist: { enabled: wl?.enabled ?? false, players } })} />
        {wlEnvErr && <p role="alert" className="text-xs text-red-400">{wlEnvErr}</p>}
        <Gestion managed={!!wl} what="la whitelist" onStop={() => clear("whitelist", ["sf-whitelist"])} />
      </div>
      <div className="flex flex-col gap-3">
        <ListField key={`ops-${resets.ops}`} id="sf-ops" label="Operadores (OPS)" kind="player" value={ops} rows={6} onError={onError} placeholder="Lobo"
          hint="Nombre de Java o UUID, uno por línea. Con la sección gestionada, quitar a alguien le quita el op al reiniciar y una lista vacía deja ops.json sin operadores."
          onChange={(list) => onChange({ ...spec, ops: list })} />
        {opsEnvErr && <p role="alert" className="text-xs text-red-400">{opsEnvErr}</p>}
        <Gestion managed={ops !== undefined} what="los operadores" onStop={() => clear("ops", ["sf-ops"])} />
      </div>
    </div>
  );
}

function Gestion({ managed, what, onStop }: { managed: boolean; what: string; onStop: () => void }) {
  if (!managed) return <p className="text-xs text-muted-foreground">No se gestiona: el panel no toca {what}. Escribe aquí para empezar a gestionarla.</p>;
  return (
    <div>
      <Button type="button" size="sm" variant="secondary" onClick={onStop}>Dejar de gestionar</Button>
      <p className="mt-1 text-xs text-muted-foreground">Quita {what} de la spec: el agente deja de sincronizar el fichero (no lo borra).</p>
    </div>
  );
}
