import { useEffect, useRef, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { validateExtraPorts, type EditableSpec } from "@/lib/spec-edit";
import { NumberField, RequiredSelect, describedBy, errId, type ReportError } from "./fields";
import { RouterSection } from "./router-section";

type Extra = EditableSpec["ports"]["extra"][number];
const PROTOS = [{ value: "tcp", label: "TCP" }, { value: "udp", label: "UDP" }] as const;

/** Port of a row: keeps its text; non-numeric input is reported (it is not silently turned into 0) and not propagated. */
function PortInput({ id, label, placeholder, value, onChange, onError }: {
  id: string; label: string; placeholder: string; value: number; onChange: (n: number) => void; onError: ReportError;
}) {
  const [text, setText] = useState(value ? String(value) : "");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => () => onError(id, null), [id, onError]);
  // Resyncs if the parent replaces the spec (and it is not the echo of what we typed). Deliberately depends only on
  // `value`: with `text`/`error` it would run on every keystroke and overwrite what is being typed.
  useEffect(() => {
    if (error === null && (/^[0-9]+$/.test(text.trim()) ? Number(text) : 0) !== value) setText(value ? String(value) : "");
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps -- see the comment above
  const update = (t: string) => {
    setText(t);
    const trimmed = t.trim();
    if (trimmed !== "" && !/^[0-9]+$/.test(trimmed)) {
      const msg = `${label}: must be an integer`;
      setError(msg); onError(id, msg); return;
    }
    setError(null); onError(id, null); onChange(trimmed === "" ? 0 : Number(trimmed));
  };
  return (
    <>
      <Input aria-label={label} inputMode="numeric" value={text} placeholder={placeholder} aria-invalid={!!error}
        aria-describedby={describedBy(id, null, error)} onChange={(e) => update(e.target.value)} />
      {error && <span id={errId(id)} className="sr-only">{error}</span>}
    </>
  );
}

/** Repeated host ports (same number and protocol): game (tcp) against extras and among extras. */
export function duplicateHostPorts(game: number | undefined, extra: readonly Extra[]): string[] {
  const seen = new Map<string, number>();
  const dups = new Set<string>();
  const add = (host: number, proto: string) => {
    if (!host) return;
    const k = `${host}/${proto}`;
    if (seen.has(k)) dups.add(k); else seen.set(k, 1);
  };
  if (game) add(game, "tcp");
  for (const e of extra) add(e.host, e.proto);
  return [...dups];
}

/**
 * "Network" section: game port (on the host), extra ports (Geyser, voice, web maps…) and the router (plan-8), which
 * `routerHidden` replaces with a text.
 */
export function NetworkSection({ spec, onChange, onError, routerHidden }: {
  spec: EditableSpec; onChange: (s: EditableSpec) => void; onError: ReportError; routerHidden?: string;
}) {
  const extra = spec.ports.extra;
  const setExtra = (list: Extra[]) => onChange({ ...spec, ports: { ...spec.ports, extra: list } });
  const dups = duplicateHostPorts(spec.ports.game, extra);
  // Stable keys per row: removing a row does not shift the local text/error of the others.
  const keys = useRef<number[]>([]);
  const nextKey = useRef(0);
  while (keys.current.length < extra.length) keys.current.push(nextKey.current++);
  keys.current.length = extra.length;
  const update = (i: number, patch: Partial<Extra>) => setExtra(extra.map((e, j) => (j === i ? { ...e, ...patch } : e)));
  // Same schema as the API (ranges, proto, no publishing RCON 25575): a single aggregated error for the form.
  const portsError = validateExtraPorts(extra);
  useEffect(() => { onError("sf-extra-ports", portsError); }, [portsError, onError]);
  return (
    <div className="flex flex-col gap-6">
      <div className="max-w-xs">
        <NumberField id="sf-port" label="Game port (host)" value={spec.ports.game} min={1} max={65535} onError={onError}
          hint="Inside the container it is always 25565. Empty = the current port is kept."
          onChange={(game) => onChange({ ...spec, ports: { ...spec.ports, game } })} />
      </div>
      <div className="flex flex-col gap-2">
        <div className="text-sm font-medium">Extra ports</div>
        {extra.length === 0 && <p className="text-xs text-muted-foreground">None. RCON (25575) is never published.</p>}
        {extra.map((e, i) => (
          <div key={keys.current[i]} className="grid grid-cols-[1fr_1fr_6rem_1.5fr_auto] items-center gap-2">
            <PortInput id={`sf-extra-${keys.current[i]}-host`} label={`Extra port #${i + 1}: host port`} placeholder="host" value={e.host} onError={onError} onChange={(host) => update(i, { host })} />
            <PortInput id={`sf-extra-${keys.current[i]}-container`} label={`Extra port #${i + 1}: container port`} placeholder="container" value={e.container} onError={onError} onChange={(container) => update(i, { container })} />
            <RequiredSelect id={`sf-proto-${i}`} value={e.proto} options={PROTOS} onChange={(p) => update(i, { proto: p as Extra["proto"] })} />
            <Input aria-label="Label" value={e.label} maxLength={40} placeholder="Geyser, voice…" onChange={(ev) => update(i, { label: ev.target.value })} />
            <Button type="button" size="icon" variant="ghost" aria-label="Remove port" onClick={() => { keys.current.splice(i, 1); setExtra(extra.filter((_, j) => j !== i)); }}><Trash2 className="size-4" /></Button>
          </div>
        ))}
        {dups.length > 0 && <p role="status" className="text-xs text-warn">Repeated host port ({dups.join(", ")}): Docker cannot publish the same port twice.</p>}
        {portsError && <p role="alert" className="text-xs text-bad">{portsError}</p>}
        <div>
          <Button type="button" size="sm" variant="secondary" onClick={() => setExtra([...extra, { host: 0, container: 0, proto: "tcp", label: "" }])}>
            <Plus className="size-4" /> Add port
          </Button>
        </div>
      </div>
      {routerHidden === undefined
        ? <RouterSection spec={spec} onChange={onChange} onError={onError} />
        : <p className="text-xs text-muted-foreground">{routerHidden}</p>}
    </div>
  );
}
