import { cloneElement, isValidElement, useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { listToText, kvToText, parseKv, parseLines, readNumberField, shouldResyncNumber, validateListItems, type ListItemKind } from "@/lib/spec-edit";

/** Reports field errors to the form (null = the field is valid again). */
export type ReportError = (field: string, message: string | null) => void;

export const hintId = (id: string) => `${id}-hint`;
export const errId = (id: string) => `${id}-err`;
/** Value of aria-describedby for a field with a hint and/or an error. */
export const describedBy = (id: string, hint: unknown, error: string | null | undefined) =>
  [hint ? hintId(id) : null, error ? errId(id) : null].filter(Boolean).join(" ") || undefined;

/** Wraps ONE control: injects aria-describedby with the hint and error present (the control must accept that prop). */
export function Field({ id, label, hint, error, children }: { id: string; label: string; hint?: React.ReactNode; error?: string | null; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {isValidElement<{ "aria-describedby"?: string }>(children) ? cloneElement(children, { "aria-describedby": describedBy(id, hint, error) }) : children}
      {hint && <p id={hintId(id)} className="text-xs text-muted-foreground">{hint}</p>}
      {error && <p id={errId(id)} role="alert" className="text-xs text-red-400">{error}</p>}
    </div>
  );
}

/** List in a textarea (one entry per line). Keeps its own text so it does not swallow line breaks while typing. */
export function ListField({ id, label, value, onChange, onError, kind = "entry", placeholder, hint, rows = 4 }: {
  id: string; label: string; value: readonly string[] | undefined; onChange: (v: string[]) => void;
  onError?: ReportError; kind?: ListItemKind; placeholder?: string; hint?: React.ReactNode; rows?: number;
}) {
  const [text, setText] = useState(() => listToText(value));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => () => onError?.(id, null), [id, onError]);
  // Resyncs if the parent replaces the value (not if it is the echo of what was emitted).
  const emitted = useRef(listToText(value));
  useEffect(() => {
    const incoming = listToText(value);
    if (incoming === emitted.current) return;
    emitted.current = incoming; setText(incoming); setError(null); onError?.(id, null);
  }, [value, id, onError]);
  const update = (t: string) => {
    setText(t);
    const items = parseLines(t);
    const bad = validateListItems(kind, items);
    const msg = bad ? `${label}: ${bad}` : null;
    setError(msg); onError?.(id, msg);
    if (!bad) { emitted.current = listToText(items); onChange(items); }
  };
  return (
    <Field id={id} label={label} hint={hint} error={error}>
      <Textarea id={id} rows={rows} className="font-mono text-xs" value={text} placeholder={placeholder}
        aria-invalid={!!error} aria-describedby={describedBy(id, hint, error)} onChange={(e) => update(e.target.value)} />
    </Field>
  );
}

/** Key=value pairs in a textarea. If a line is invalid, it reports through onError and does not propagate the value. */
export function KvField({ id, label, value, onChange, onError, placeholder, hint, rows = 6, validate }: {
  id: string; label: string; value: Record<string, string> | undefined; onChange: (v: Record<string, string>) => void;
  onError: ReportError; placeholder?: string; hint?: React.ReactNode; rows?: number;
  /** Extra validation of the already parsed pairs (reserved keys…): message or null. If it fails, the value is not propagated. */
  validate?: (kv: Record<string, string>) => string | null;
}) {
  const [text, setText] = useState(() => kvToText(value));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => () => onError(id, null), [id, onError]);
  // Resyncs if the parent replaces the value (reload, discard changes); not if it is the echo of what we typed.
  const emitted = useRef(kvToText(value));
  useEffect(() => {
    const incoming = kvToText(value);
    if (incoming === emitted.current) return;
    emitted.current = incoming; setText(incoming); setError(null); onError(id, null);
  }, [value, id, onError]);
  const update = (t: string) => {
    setText(t);
    try {
      const kv = parseKv(t);
      const bad = validate?.(kv);
      if (bad) throw new Error(bad);
      emitted.current = kvToText(kv);
      setError(null); onError(id, null); onChange(kv);
    } catch (e) {
      const msg = `${label}: ${(e as Error).message}`;
      setError(msg); onError(id, msg);
    }
  };
  return (
    <Field id={id} label={label} hint={hint} error={error}>
      <Textarea id={id} rows={rows} className="font-mono text-xs" value={text} placeholder={placeholder}
        aria-invalid={!!error} aria-describedby={describedBy(id, hint, error)} onChange={(e) => update(e.target.value)} />
    </Field>
  );
}

/** Optional number (empty = undefined). Only accepts NON-negative integers (or non-negative decimals with integer=false): if a negative is needed, extend the regex.  Reports through onError if it is not a valid number in [min, max]. */
export function NumberField({ id, label, value, onChange, onError, min, max, integer = true, placeholder, hint, zeroIsEmpty }: {
  zeroIsEmpty?: boolean;
  id: string; label: string; value: number | undefined; onChange: (v: number | undefined) => void; onError: ReportError;
  min?: number; max?: number; integer?: boolean; placeholder?: string; hint?: React.ReactNode;
}) {
  const [text, setText] = useState(() => (value === undefined ? "" : String(value)));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => () => onError(id, null), [id, onError]);
  const emitted = useRef(value);
  // Only when the parent's value changes: `text` and `zeroIsEmpty` are read but deliberately not dependencies.
  // With `text` the effect would run on every keystroke and compare the parent's previous value with what is being
  // typed (it would overwrite "0." or an invalid text not yet corrected); the decision is in shouldResyncNumber.
  useEffect(() => {
    if (!shouldResyncNumber({ text, incoming: value, emitted: emitted.current, zeroIsEmpty })) { emitted.current = value; return; }
    emitted.current = value; setText(value === undefined ? "" : String(value)); setError(null); onError(id, null);
  }, [value, id, onError]); // eslint-disable-line react-hooks/exhaustive-deps -- see the comment above
  const update = (t: string) => {
    setText(t);
    const r = readNumberField(t, { label, integer, min, max });
    if (!r.ok) { setError(r.error); onError(id, r.error); return; }
    setError(null); onError(id, null); emitted.current = r.value; onChange(r.value);
  };
  return (
    <Field id={id} label={label} hint={hint} error={error}>
      <Input id={id} value={text} inputMode={integer ? "numeric" : "decimal"} placeholder={placeholder} aria-invalid={!!error}
        aria-describedby={describedBy(id, hint, error)} onChange={(e) => update(e.target.value)} />
    </Field>
  );
}

const DEFAULT = "__default__"; // Radix Select does not support value=""

/** Select with a "(default)" option equivalent to not setting the value. */
export function OptionalSelect({ id, value, options, onChange, defaultLabel = "(default)", "aria-describedby": describedby }: {
  id: string; "aria-describedby"?: string; value: string | undefined; options: readonly { value: string; label: string }[]; onChange: (v: string | undefined) => void; defaultLabel?: string;
}) {
  const known = value === undefined || options.some((o) => o.value === value);
  const all = known ? options : [{ value: value!, label: value! }, ...options];
  return (
    <Select value={value ?? DEFAULT} onValueChange={(v) => onChange(v === DEFAULT ? undefined : v)}>
      <SelectTrigger id={id} aria-describedby={describedby}><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value={DEFAULT}>{defaultLabel}</SelectItem>
        {all.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

/** Required select; if the current value is not in the list (e.g. an imported type) it is added. */
export function RequiredSelect({ id, value, options, onChange, "aria-describedby": describedby }: {
  id: string; "aria-describedby"?: string; value: string; options: readonly { value: string; label: string }[]; onChange: (v: string) => void;
}) {
  const all = options.some((o) => o.value === value) ? options : [{ value, label: value }, ...options];
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id} aria-describedby={describedby}><SelectValue /></SelectTrigger>
      <SelectContent>{all.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
    </Select>
  );
}

/**
 * Single-line text with validation: if `validate` fails it reports through onError and does NOT propagate the value
 * (the spec keeps the last valid one). `externalError` adds an error that depends on another field.
 */
export function ValidatedInput({ id, label, value, onChange, onError, validate, externalError, placeholder, hint }: {
  id: string; label: string; value: string; onChange: (v: string) => void; onError: ReportError;
  validate: (v: string) => string | null; externalError?: string | null; placeholder?: string; hint?: React.ReactNode;
}) {
  const [text, setText] = useState(value);
  const [own, setOwn] = useState<string | null>(null);
  useEffect(() => () => onError(id, null), [id, onError]);
  const emitted = useRef(value);
  useEffect(() => {
    if (value === emitted.current) return;
    emitted.current = value; setText(value); setOwn(null); onError(id, null);
  }, [value, id, onError]);
  const update = (raw: string) => {
    const t = raw.trim();
    setText(raw);
    const bad = validate(t);
    const msg = bad ? `${label}: ${bad}` : null;
    setOwn(msg); onError(id, msg);
    if (!bad) { emitted.current = t; onChange(t); }
  };
  const error = own ?? externalError ?? null;
  return (
    <Field id={id} label={label} hint={hint} error={error}>
      <Input id={id} value={text} placeholder={placeholder} aria-invalid={!!error} aria-describedby={describedBy(id, hint, error)}
        onChange={(e) => update(e.target.value)} />
    </Field>
  );
}
