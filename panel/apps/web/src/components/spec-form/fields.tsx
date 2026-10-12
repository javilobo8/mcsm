import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { listToText, kvToText, parseKv, parseList } from "@/lib/spec-edit";

/** Notifica errores de campo al formulario (null = el campo vuelve a ser válido). */
export type ReportError = (field: string, message: string | null) => void;

export function Field({ id, label, hint, children }: { id: string; label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** Lista en un textarea (una entrada por línea). Guarda su propio texto para no comerse los saltos de línea al escribir. */
export function ListField({ id, label, value, onChange, placeholder, hint, rows = 4 }: {
  id: string; label: string; value: readonly string[] | undefined; onChange: (v: string[]) => void;
  placeholder?: string; hint?: React.ReactNode; rows?: number;
}) {
  const [text, setText] = useState(() => listToText(value));
  return (
    <Field id={id} label={label} hint={hint}>
      <Textarea id={id} rows={rows} className="font-mono text-xs" value={text} placeholder={placeholder}
        onChange={(e) => { setText(e.target.value); onChange(parseList(e.target.value)); }} />
    </Field>
  );
}

/** Pares clave=valor en un textarea. Si una línea es inválida, avisa con onError y no propaga el valor. */
export function KvField({ id, label, value, onChange, onError, placeholder, hint, rows = 6 }: {
  id: string; label: string; value: Record<string, string> | undefined; onChange: (v: Record<string, string>) => void;
  onError: ReportError; placeholder?: string; hint?: React.ReactNode; rows?: number;
}) {
  const [text, setText] = useState(() => kvToText(value));
  const [error, setError] = useState<string | null>(null);
  const update = (t: string) => {
    setText(t);
    try {
      const kv = parseKv(t);
      setError(null); onError(id, null); onChange(kv);
    } catch (e) {
      const msg = `${label}: ${(e as Error).message}`;
      setError(msg); onError(id, msg);
    }
  };
  return (
    <Field id={id} label={label} hint={hint}>
      <Textarea id={id} rows={rows} className="font-mono text-xs" value={text} placeholder={placeholder}
        aria-invalid={!!error} onChange={(e) => update(e.target.value)} />
      {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
    </Field>
  );
}

/** Número opcional (vacío = undefined). Avisa con onError si no es un número válido en [min, max]. */
export function NumberField({ id, label, value, onChange, onError, min, max, integer = true, placeholder, hint }: {
  id: string; label: string; value: number | undefined; onChange: (v: number | undefined) => void; onError: ReportError;
  min?: number; max?: number; integer?: boolean; placeholder?: string; hint?: React.ReactNode;
}) {
  const [text, setText] = useState(() => (value === undefined ? "" : String(value)));
  const [error, setError] = useState<string | null>(null);
  const update = (t: string) => {
    setText(t);
    const trimmed = t.trim();
    if (trimmed === "") { setError(null); onError(id, null); onChange(undefined); return; }
    const n = Number(trimmed.replace(",", "."));
    const bad = !Number.isFinite(n) || (integer && !Number.isInteger(n)) || (min !== undefined && n < min) || (max !== undefined && n > max);
    if (bad) {
      const range = min !== undefined && max !== undefined ? ` entre ${min} y ${max}` : min !== undefined ? ` ≥ ${min}` : "";
      const msg = `${label}: debe ser un número${integer ? " entero" : ""}${range}`;
      setError(msg); onError(id, msg); return;
    }
    setError(null); onError(id, null); onChange(n);
  };
  return (
    <Field id={id} label={label} hint={hint}>
      <Input id={id} value={text} inputMode={integer ? "numeric" : "decimal"} placeholder={placeholder} aria-invalid={!!error} onChange={(e) => update(e.target.value)} />
      {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
    </Field>
  );
}

const DEFAULT = "__default__"; // Radix Select no admite value=""

/** Select con opción "(por defecto)" que equivale a no fijar el valor. */
export function OptionalSelect({ id, value, options, onChange, defaultLabel = "(por defecto)" }: {
  id: string; value: string | undefined; options: readonly { value: string; label: string }[]; onChange: (v: string | undefined) => void; defaultLabel?: string;
}) {
  const known = value === undefined || options.some((o) => o.value === value);
  const all = known ? options : [{ value: value!, label: value! }, ...options];
  return (
    <Select value={value ?? DEFAULT} onValueChange={(v) => onChange(v === DEFAULT ? undefined : v)}>
      <SelectTrigger id={id}><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value={DEFAULT}>{defaultLabel}</SelectItem>
        {all.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

/** Select obligatorio; si el valor actual no está en la lista (p. ej. un tipo importado) se añade. */
export function RequiredSelect({ id, value, options, onChange }: {
  id: string; value: string; options: readonly { value: string; label: string }[]; onChange: (v: string) => void;
}) {
  const all = options.some((o) => o.value === value) ? options : [{ value, label: value }, ...options];
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id}><SelectValue /></SelectTrigger>
      <SelectContent>{all.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
    </Select>
  );
}
