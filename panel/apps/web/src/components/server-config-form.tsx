import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff } from "lucide-react";
import type { SpecInput } from "@mcsm/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, apiPath, ApiError, type ServerDto } from "@/lib/api";
import { buildSpec, diffSpec, valuesFromSpec, type Change, type FormValues } from "@/lib/spec-form";
import { JAVA_TAGS, SERVER_TYPES } from "@/routes/new-server";

const RESTART = ["unless-stopped", "always", "on-failure", "no"] as const;

interface Pending { name: string; spec: SpecInput; changes: Change[] }

export function ServerConfigForm({ server }: { server: ServerDto }) {
  const qc = useQueryClient();
  const [name, setName] = useState(server.name);
  const [v, setV] = useState<FormValues>(() => valuesFromSpec(server.spec));
  // Línea base: lo cargado en el formulario y su versión (para detectar cambios hechos fuera).
  const [base, setBase] = useState({ version: server.specVersion, name: server.name, v: valuesFromSpec(server.spec) });
  const dirty = name !== base.name || JSON.stringify(v) !== JSON.stringify(base.v);
  const stale = server.specVersion !== base.version;
  const reload = () => {
    const nv = valuesFromSpec(server.spec);
    setName(server.name); setV(nv); setBase({ version: server.specVersion, name: server.name, v: nv });
    setLocalErr(null);
  };
  useEffect(() => { if (stale && !dirty) reload(); }, [stale, dirty]); // eslint-disable-line react-hooks/exhaustive-deps
  const [showRcon, setShowRcon] = useState(false);
  const [localErr, setLocalErr] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const set = (k: keyof FormValues, val: string) => setV((o) => ({ ...o, [k]: val }));

  const save = useMutation({
    // El PATCH reemplaza la spec entera: siempre se envía la completa (la del GET, modificada).
    mutationFn: (p: Pending) => api.patch<ServerDto>(apiPath`/api/servers/${server.id}`, { name: p.name, spec: p.spec }),
    onSuccess: (dto) => {
      setPending(null);
      const nv = valuesFromSpec(dto.spec);
      setName(dto.name); setV(nv); setBase({ version: dto.specVersion, name: dto.name, v: nv });
      qc.setQueryData(["server", server.id], dto);
      void qc.invalidateQueries({ queryKey: ["servers"] });
    },
    onError: () => setPending(null),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault(); setLocalErr(null); save.reset();
    const trimmed = name.trim();
    if (!trimmed) return setLocalErr("El nombre no puede estar vacío");
    try {
      const spec = buildSpec(server.spec, v);
      const changes = diffSpec(server.spec, spec);
      if (trimmed !== server.name) changes.unshift({ path: "nombre", before: server.name, after: trimmed });
      if (changes.length === 0) return setLocalErr("No hay cambios que aplicar");
      setPending({ name: trimmed, spec, changes });
    } catch (err) {
      setLocalErr((err as Error).message);
    }
  };

  const field = (id: string, label: string, children: React.ReactNode) => (
    <div className="flex flex-col gap-1.5"><Label htmlFor={id}>{label}</Label>{children}</div>
  );
  const sel = (id: string, key: keyof FormValues, options: readonly string[]) => (
    <Select value={v[key]} onValueChange={(x) => set(key, x)}>
      <SelectTrigger id={id}><SelectValue /></SelectTrigger>
      <SelectContent>{options.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
    </Select>
  );
  const err = localErr ?? (save.error instanceof ApiError ? save.error.message : save.error ? "Error inesperado" : null);

  return (
    <form onSubmit={submit} className="flex max-w-3xl flex-col gap-6" data-testid="config-form">
      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">{field("cf-name", "Nombre", <Input id="cf-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />)}</div>
        {field("cf-type", "Tipo", sel("cf-type", "type", SERVER_TYPES.includes(v.type as never) ? SERVER_TYPES : [v.type, ...SERVER_TYPES]))}
        {field("cf-version", "Versión", <Input id="cf-version" value={v.version} onChange={(e) => set("version", e.target.value)} />)}
        {field("cf-java", "Java", sel("cf-java", "imageTag", JAVA_TAGS.includes(v.imageTag as never) ? JAVA_TAGS : [v.imageTag, ...JAVA_TAGS]))}
        {field("cf-memory", "Memoria JVM", <Input id="cf-memory" value={v.memory} onChange={(e) => set("memory", e.target.value)} placeholder="4G" />)}
        {field("cf-port", "Puerto de juego", <Input id="cf-port" value={v.port} inputMode="numeric" onChange={(e) => set("port", e.target.value)} />)}
        {field("cf-restart", "Política de reinicio", sel("cf-restart", "restartPolicy", RESTART))}
        {field("cf-cpus", "Límite de CPUs (vacío = sin límite)", <Input id="cf-cpus" value={v.cpus} inputMode="decimal" onChange={(e) => set("cpus", e.target.value)} placeholder="2" />)}
        {field("cf-memlimit", "Límite de RAM del contenedor", <Input id="cf-memlimit" value={v.memLimit} onChange={(e) => set("memLimit", e.target.value)} placeholder="5G (≥ memoria JVM + 1G)" />)}
      </section>
      <section className="flex flex-col gap-1.5">
        <Label htmlFor="cf-props">server.properties (clave=valor por línea)</Label>
        <Textarea id="cf-props" rows={8} className="font-mono text-xs" value={v.properties} onChange={(e) => set("properties", e.target.value)} placeholder={"motd=Mi servidor\nmax-players=10\ndifficulty=normal"} />
      </section>
      <section className="flex flex-col gap-1.5">
        <Label htmlFor="cf-env">Variables de entorno extra de la imagen itzg (CLAVE=valor por línea)</Label>
        <Textarea id="cf-env" rows={6} className="font-mono text-xs" value={v.env} onChange={(e) => set("env", e.target.value)} placeholder={"USE_AIKAR_FLAGS=true\nENABLE_AUTOPAUSE=false"} />
        <p className="text-xs text-muted-foreground">No se pueden sobreescribir TYPE, VERSION, MEMORY, EULA, RCON_* ni SERVER_PORT: se generan desde los campos de arriba.</p>
      </section>
      {server.spec.rconPassword && (
        <section className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>Contraseña RCON:</span>
          <code className="rounded bg-zinc-900 px-1.5 py-0.5" data-testid="rcon">{showRcon ? server.spec.rconPassword : "••••••••••••"}</code>
          <Button type="button" size="sm" variant="ghost" onClick={() => setShowRcon((s) => !s)} aria-pressed={showRcon}>
            {showRcon ? <EyeOff className="size-4" /> : <Eye className="size-4" />}{showRcon ? "Ocultar" : "Revelar"}
          </Button>
        </section>
      )}
      {stale && dirty && (
        <p role="alert" className="flex items-center gap-2 rounded-md border border-amber-700 bg-amber-950/30 p-2 text-sm text-amber-300">
          La configuración cambió en el servidor (v{server.specVersion}) y tienes cambios sin guardar.
          <Button type="button" size="sm" variant="secondary" onClick={reload}>Recargar y descartar mis cambios</Button>
        </p>
      )}
      {err && <p role="alert" className="text-sm text-red-400">{err}</p>}
      {save.isSuccess && <p role="status" className="text-sm text-emerald-400">Guardado (v{save.data.specVersion}). El agente recreará el contenedor si hace falta.</p>}
      <div><Button type="submit" disabled={save.isPending}>Revisar y aplicar</Button></div>

      <Dialog open={pending !== null} onOpenChange={(o) => { if (!o && !save.isPending) setPending(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Aplicar cambios en «{server.name}»</DialogTitle>
            <DialogDescription>Si cambian ajustes del contenedor, se recreará y el servidor se reiniciará.</DialogDescription>
          </DialogHeader>
          <ul className="max-h-72 space-y-1 overflow-auto font-mono text-xs" data-testid="spec-diff">
            {pending?.changes.map((c) => (
              <li key={c.path} className="rounded border border-border p-2">
                <div className="text-muted-foreground">{c.path}</div>
                <div className="text-red-300 break-all">- {c.before}</div>
                <div className="text-emerald-300 break-all">+ {c.after}</div>
              </li>
            ))}
          </ul>
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={save.isPending} onClick={() => setPending(null)}>Cancelar</Button>
            <Button type="button" disabled={save.isPending} onClick={() => pending && save.mutate(pending)}>{save.isPending ? "Aplicando…" : "Aplicar"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </form>
  );
}
