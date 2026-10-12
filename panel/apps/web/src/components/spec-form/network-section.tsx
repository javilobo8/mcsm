import { useEffect, useRef, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { validateExtraPorts, type EditableSpec } from "@/lib/spec-edit";
import { NumberField, RequiredSelect, describedBy, errId, type ReportError } from "./fields";
import { RouterSection } from "./router-section";

type Extra = EditableSpec["ports"]["extra"][number];
const PROTOS = [{ value: "tcp", label: "TCP" }, { value: "udp", label: "UDP" }] as const;

/** Puerto de una fila: guarda su texto; lo no numérico se avisa (no se convierte en 0 en silencio) y no se propaga. */
function PortInput({ id, label, placeholder, value, onChange, onError }: {
  id: string; label: string; placeholder: string; value: number; onChange: (n: number) => void; onError: ReportError;
}) {
  const [text, setText] = useState(value ? String(value) : "");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => () => onError(id, null), [id, onError]);
  // Resincroniza si el padre reemplaza la spec (y no es el eco de lo que escribimos). Solo depende de `value`
  // a propósito: con `text`/`error` correría a cada tecla y pisaría lo que se está escribiendo.
  useEffect(() => {
    if (error === null && (/^[0-9]+$/.test(text.trim()) ? Number(text) : 0) !== value) setText(value ? String(value) : "");
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps -- ver el comentario de arriba
  const update = (t: string) => {
    setText(t);
    const trimmed = t.trim();
    if (trimmed !== "" && !/^[0-9]+$/.test(trimmed)) {
      const msg = `${label}: debe ser un número entero`;
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

/** Puertos de host repetidos (mismo número y protocolo): juego (tcp) contra extras y entre extras. */
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

/** Sección "Red": puerto de juego (en el host) y puertos extra (Geyser, voz, mapas web…). */
export function NetworkSection({ spec, onChange, onError }: { spec: EditableSpec; onChange: (s: EditableSpec) => void; onError: ReportError }) {
  const extra = spec.ports.extra;
  const setExtra = (list: Extra[]) => onChange({ ...spec, ports: { ...spec.ports, extra: list } });
  const dups = duplicateHostPorts(spec.ports.game, extra);
  // Claves estables por fila: quitar una fila no desplaza el texto/error local de las demás.
  const keys = useRef<number[]>([]);
  const nextKey = useRef(0);
  while (keys.current.length < extra.length) keys.current.push(nextKey.current++);
  keys.current.length = extra.length;
  const update = (i: number, patch: Partial<Extra>) => setExtra(extra.map((e, j) => (j === i ? { ...e, ...patch } : e)));
  // Mismo esquema que la API (rangos, proto, sin publicar RCON 25575): un único error agregado para el formulario.
  const portsError = validateExtraPorts(extra);
  useEffect(() => { onError("sf-extra-ports", portsError); }, [portsError, onError]);
  return (
    <div className="flex flex-col gap-6">
      <div className="max-w-xs">
        <NumberField id="sf-port" label="Puerto de juego (host)" value={spec.ports.game} min={1} max={65535} onError={onError}
          hint="Dentro del contenedor siempre es 25565. Vacío = se conserva el puerto actual."
          onChange={(game) => onChange({ ...spec, ports: { ...spec.ports, game } })} />
      </div>
      <div className="flex flex-col gap-2">
        <div className="text-sm font-medium">Puertos extra</div>
        {extra.length === 0 && <p className="text-xs text-muted-foreground">Ninguno. RCON (25575) nunca se publica.</p>}
        {extra.map((e, i) => (
          <div key={keys.current[i]} className="grid grid-cols-[1fr_1fr_6rem_1.5fr_auto] items-center gap-2">
            <PortInput id={`sf-extra-${keys.current[i]}-host`} label={`Puerto extra #${i + 1}: puerto en el host`} placeholder="host" value={e.host} onError={onError} onChange={(host) => update(i, { host })} />
            <PortInput id={`sf-extra-${keys.current[i]}-container`} label={`Puerto extra #${i + 1}: puerto en el contenedor`} placeholder="contenedor" value={e.container} onError={onError} onChange={(container) => update(i, { container })} />
            <RequiredSelect id={`sf-proto-${i}`} value={e.proto} options={PROTOS} onChange={(p) => update(i, { proto: p as Extra["proto"] })} />
            <Input aria-label="Etiqueta" value={e.label} maxLength={40} placeholder="Geyser, voz…" onChange={(ev) => update(i, { label: ev.target.value })} />
            <Button type="button" size="icon" variant="ghost" aria-label="Quitar puerto" onClick={() => { keys.current.splice(i, 1); setExtra(extra.filter((_, j) => j !== i)); }}><Trash2 className="size-4" /></Button>
          </div>
        ))}
        {dups.length > 0 && <p role="status" className="text-xs text-amber-400">Puerto de host repetido ({dups.join(", ")}): Docker no puede publicar dos veces el mismo puerto.</p>}
        {portsError && <p role="alert" className="text-xs text-red-400">{portsError}</p>}
        <div>
          <Button type="button" size="sm" variant="secondary" onClick={() => setExtra([...extra, { host: 0, container: 0, proto: "tcp", label: "" }])}>
            <Plus className="size-4" /> Añadir puerto
          </Button>
        </div>
      </div>
      <RouterSection spec={spec} onChange={onChange} onError={onError} />
    </div>
  );
}
