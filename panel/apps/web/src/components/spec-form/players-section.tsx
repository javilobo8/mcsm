import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { offlineModeWarning } from "@/lib/players";
import { playersEnvErrors, type EditableSpec } from "@/lib/spec-edit";
import { ListField, type ReportError } from "./fields";

/**
 * "Players" section: whitelist and operators (WHITELIST/ENABLE_WHITELIST and OPS).
 * Absent is not empty: opening the section creates nothing; the list becomes managed when edited, and
 * “Stop managing” removes it from the spec (the agent stops touching the file).
 */
export function PlayersSection({ spec, onChange, onError }: { spec: EditableSpec; onChange: (s: EditableSpec) => void; onError?: ReportError }) {
  const wl = spec.whitelist;
  const ops = spec.ops;
  // Only "Stop managing" remounts the textarea (to clear its text); enabling does not, or focus would be lost.
  const [resets, setResets] = useState({ wl: 0, ops: 0 });
  // OPS/WHITELIST/ENABLE_WHITELIST… in Advanced would win over these lists: an error of this section (blocks applying).
  const envErr = playersEnvErrors(spec);
  const opsEnvErr = envErr["sf-ops-env"];
  const wlEnvErr = envErr["sf-whitelist-env"];
  useEffect(() => { onError?.("sf-ops-env", opsEnvErr); }, [opsEnvErr, onError]);
  useEffect(() => { onError?.("sf-whitelist-env", wlEnvErr); }, [wlEnvErr, onError]);
  useEffect(() => () => { onError?.("sf-ops-env", null); onError?.("sf-whitelist-env", null); }, [onError]);
  const offline = offlineModeWarning(spec);
  const clear = (key: "whitelist" | "ops", ids: string[]) => {
    for (const id of ids) onError?.(id, null);
    setResets((r) => ({ ...r, [key === "ops" ? "ops" : "wl"]: r[key === "ops" ? "ops" : "wl"] + 1 }));
    const { [key]: _drop, ...rest } = spec;
    onChange(rest as EditableSpec);
  };
  return (
    <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
      {offline && <p role="note" className="text-xs text-warn sm:col-span-2">{offline}</p>}
      <div className="flex flex-col gap-3">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" checked={wl?.enabled ?? false}
            onChange={(e) => onChange({ ...spec, whitelist: { enabled: e.target.checked, players: wl?.players ?? [] } })} />
          Enable whitelist (only those on the list can join)
        </label>
        <ListField key={`wl-${resets.wl}`} id="sf-whitelist" label="Whitelist players" kind="player" value={wl?.players} rows={6} onError={onError} placeholder={"Lobo\nSteve"}
          hint="Java name or UUID, one per line. On start, whitelist.json ends up identical to this list: anything added with /whitelist add is lost (set EXISTING_WHITELIST_FILE=MERGE in Advanced if you prefer to add)."
          onChange={(players) => onChange({ ...spec, whitelist: { enabled: wl?.enabled ?? false, players } })} />
        {wlEnvErr && <p role="alert" className="text-xs text-bad">{wlEnvErr}</p>}
        <Gestion managed={!!wl} what="the whitelist" onStop={() => clear("whitelist", ["sf-whitelist"])} />
      </div>
      <div className="flex flex-col gap-3">
        <ListField key={`ops-${resets.ops}`} id="sf-ops" label="Operators (OPS)" kind="player" value={ops} rows={6} onError={onError} placeholder="Lobo"
          hint="Java name or UUID, one per line. With the section managed, removing someone removes their op on restart and an empty list leaves ops.json without operators."
          onChange={(list) => onChange({ ...spec, ops: list })} />
        {opsEnvErr && <p role="alert" className="text-xs text-bad">{opsEnvErr}</p>}
        <Gestion managed={ops !== undefined} what="the operators" onStop={() => clear("ops", ["sf-ops"])} />
      </div>
    </div>
  );
}

function Gestion({ managed, what, onStop }: { managed: boolean; what: string; onStop: () => void }) {
  if (!managed) return <p className="text-xs text-muted-foreground">Not managed: the panel does not touch {what}. Type here to start managing it.</p>;
  return (
    <div>
      <Button type="button" size="sm" variant="secondary" onClick={onStop}>Stop managing</Button>
      <p className="mt-1 text-xs text-muted-foreground">Removes {what} from the spec: the agent stops syncing the file (it does not delete it).</p>
    </div>
  );
}
