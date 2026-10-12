import { useEffect } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { validateExtraPorts, type EditableSpec } from "@/lib/spec-edit";
import { NumberField, RequiredSelect, type ReportError } from "./fields";

type Extra = EditableSpec["ports"]["extra"][number];
const PROTOS = [{ value: "tcp", label: "TCP" }, { value: "udp", label: "UDP" }] as const;

function toPort(text: string): number { return /^[0-9]+$/.test(text.trim()) ? Number(text) : 0; }

/** Sección "Red": puerto de juego (en el host) y puertos extra (Geyser, voz, mapas web…). */
export function NetworkSection({ spec, onChange, onError }: { spec: EditableSpec; onChange: (s: EditableSpec) => void; onError: ReportError }) {
  const extra = spec.ports.extra;
  const setExtra = (list: Extra[]) => onChange({ ...spec, ports: { ...spec.ports, extra: list } });
  const update = (i: number, patch: Partial<Extra>) => setExtra(extra.map((e, j) => (j === i ? { ...e, ...patch } : e)));
  // Mismo esquema que la API (rangos, proto, sin publicar RCON 25575): un único error agregado para el formulario.
  const portsError = validateExtraPorts(extra);
  useEffect(() => { onError("sf-extra-ports", portsError); }, [portsError, onError]);
  return (
    <div className="flex flex-col gap-6">
      <div className="max-w-xs">
        <NumberField id="sf-port" label="Puerto de juego (host)" value={spec.ports.game} min={1} max={65535} onError={onError}
          hint="Dentro del contenedor siempre es 25565. Vacío = el panel elige uno libre."
          onChange={(game) => onChange({ ...spec, ports: { ...spec.ports, game } })} />
      </div>
      <div className="flex flex-col gap-2">
        <div className="text-sm font-medium">Puertos extra</div>
        {extra.length === 0 && <p className="text-xs text-muted-foreground">Ninguno. RCON (25575) nunca se publica.</p>}
        {extra.map((e, i) => (
          <div key={i} className="grid grid-cols-[1fr_1fr_6rem_1.5fr_auto] items-center gap-2">
            <Input aria-label="Puerto en el host" inputMode="numeric" value={e.host || ""} placeholder="host" onChange={(ev) => update(i, { host: toPort(ev.target.value) })} />
            <Input aria-label="Puerto en el contenedor" inputMode="numeric" value={e.container || ""} placeholder="contenedor" onChange={(ev) => update(i, { container: toPort(ev.target.value) })} />
            <RequiredSelect id={`sf-proto-${i}`} value={e.proto} options={PROTOS} onChange={(p) => update(i, { proto: p as Extra["proto"] })} />
            <Input aria-label="Etiqueta" value={e.label} maxLength={40} placeholder="Geyser, voz…" onChange={(ev) => update(i, { label: ev.target.value })} />
            <Button type="button" size="icon" variant="ghost" aria-label="Quitar puerto" onClick={() => setExtra(extra.filter((_, j) => j !== i))}><Trash2 className="size-4" /></Button>
          </div>
        ))}
        {portsError && <p role="alert" className="text-xs text-red-400">{portsError}</p>}
        <div>
          <Button type="button" size="sm" variant="secondary" onClick={() => setExtra([...extra, { host: 0, container: 0, proto: "tcp", label: "" }])}>
            <Plus className="size-4" /> Añadir puerto
          </Button>
        </div>
      </div>
    </div>
  );
}
