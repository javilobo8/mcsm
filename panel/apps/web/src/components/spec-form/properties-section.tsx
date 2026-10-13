import { Input } from "@/components/ui/input";
import { PROPERTY_DEFS, type PropDef } from "@/lib/spec-catalog";
import { replaceOtherProperties, setProperty, splitProperties, validateExtraProperties, type EditableSpec } from "@/lib/spec-edit";
import { Field, KvField, NumberField, OptionalSelect, type ReportError } from "./fields";

const BOOL_OPTIONS = [{ value: "true", label: "Yes" }, { value: "false", label: "No" }] as const;
/** The server.properties values are single-line: a pasted line break becomes a space. */
const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ");

function TypedProperty({ def, value, onChange, onError }: { def: PropDef; value: string | undefined; onChange: (v: string | undefined) => void; onError: ReportError }) {
  const id = `sf-prop-${def.key}`;
  const label = `${def.label} (${def.key})`;
  if (def.kind === "bool") return <Field id={id} label={label}><OptionalSelect id={id} value={value} options={BOOL_OPTIONS} onChange={onChange} /></Field>;
  if (def.kind === "enum") return <Field id={id} label={label}><OptionalSelect id={id} value={value} options={(def.options ?? []).map((o) => ({ value: o, label: o }))} onChange={onChange} /></Field>;
  if (def.kind === "int") {
    const n = value === undefined || value === "" ? undefined : Number(value);
    return <NumberField id={id} label={label} value={Number.isFinite(n) ? n : undefined} min={def.min} max={def.max} placeholder={def.placeholder}
      onError={onError} onChange={(v) => onChange(v === undefined ? undefined : String(v))} />;
  }
  return <Field id={id} label={label}><Input id={id} value={value ?? ""} placeholder={def.placeholder} onChange={(e) => onChange(oneLine(e.target.value))} /></Field>;
}

/** "Properties" section: ~20 typed fields + the rest of server.properties as text. Empty = the image's default value. */
export function PropertiesSection({ spec, onChange, onError }: { spec: EditableSpec; onChange: (s: EditableSpec) => void; onError: ReportError }) {
  const props = spec.properties;
  const { other } = splitProperties(props);
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {PROPERTY_DEFS.map((def) => (
          <TypedProperty key={def.key} def={def} value={props[def.key]} onError={onError}
            onChange={(v) => onChange({ ...spec, properties: setProperty(spec.properties, def.key, v) })} />
        ))}
      </div>
      <KvField id="sf-props-other" label="Other server.properties properties (key=value per line)" value={other} onError={onError}
        validate={validateExtraProperties}
        placeholder={"spawn-npcs=true\nresource-pack=https://…"} hint="They are passed with CUSTOM_SERVER_PROPERTIES. server-port, enable-rcon and rcon.* are not allowed; values are single-line."
        onChange={(kv) => onChange({ ...spec, properties: replaceOtherProperties(spec.properties, kv) })} />
    </div>
  );
}
