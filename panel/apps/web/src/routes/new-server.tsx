import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, type ServerDto } from "@/lib/api";
import { useNodes } from "@/hooks/use-nodes";

export const SERVER_TYPES = ["VANILLA", "PAPER", "PURPUR", "SPIGOT", "FABRIC", "FORGE", "NEOFORGE", "QUILT"] as const;
export const JAVA_TAGS = ["java21", "java17", "java8", "java25", "latest"] as const;

export function NewServerPage() {
  const nodes = useNodes();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [form, setForm] = useState({ nodeId: "", name: "", type: "PAPER", version: "LATEST", imageTag: "java21", memory: "4G", port: "", start: true });
  const set = (k: keyof typeof form, v: string | boolean) => setForm((f) => ({ ...f, [k]: v }));

  const port = form.port.trim() === "" ? undefined : Number(form.port);
  const portInvalid = port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535);

  const create = useMutation({
    mutationFn: () => api.post<ServerDto>("/api/servers", {
      nodeId: form.nodeId, name: form.name.trim(), desiredState: form.start ? "running" : "stopped",
      spec: { type: form.type, version: form.version.trim(), imageTag: form.imageTag, memory: form.memory.trim(), ports: port !== undefined ? { game: port } : {} },
    }),
    onSuccess: (s) => {
      void qc.invalidateQueries({ queryKey: ["servers"] });
      void navigate({ to: "/servers/$serverId", params: { serverId: s.id } });
    },
  });

  const online = nodes.data?.filter((n) => n.status === "online") ?? [];
  return (
    <div className="p-6">
      <Card className="max-w-xl">
        <CardHeader><CardTitle>Nuevo servidor</CardTitle></CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
            <div className="flex flex-col gap-1.5"><Label htmlFor="ns-node">Nodo</Label>
              <Select value={form.nodeId} onValueChange={(v) => set("nodeId", v)}>
                <SelectTrigger id="ns-node"><SelectValue placeholder={nodes.isPending ? "Cargando nodos…" : "Elige un nodo"} /></SelectTrigger>
                <SelectContent>{nodes.data?.map((n) => <SelectItem key={n.id} value={n.id}>{n.name}{n.status !== "online" ? " (desconectado)" : ""}</SelectItem>)}</SelectContent>
              </Select>
              {nodes.isError && <p role="alert" className="text-xs text-red-400">No se pudieron cargar los nodos: {nodes.error.message}</p>}
              {nodes.data && online.length === 0 && <p className="text-xs text-amber-400">Ningún nodo conectado: el servidor se creará cuando el nodo vuelva.</p>}
            </div>
            <div className="flex flex-col gap-1.5"><Label htmlFor="ns-name">Nombre</Label><Input id="ns-name" value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Supervivencia 2026" maxLength={60} required /></div>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5"><Label htmlFor="ns-type">Tipo</Label>
                <Select value={form.type} onValueChange={(v) => set("type", v)}><SelectTrigger id="ns-type"><SelectValue /></SelectTrigger>
                  <SelectContent>{SERVER_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent></Select></div>
              <div className="flex flex-col gap-1.5"><Label htmlFor="ns-version">Versión de Minecraft</Label><Input id="ns-version" value={form.version} onChange={(e) => set("version", e.target.value)} placeholder="LATEST o 1.21.4" required /></div>
              <div className="flex flex-col gap-1.5"><Label htmlFor="ns-java">Java</Label>
                <Select value={form.imageTag} onValueChange={(v) => set("imageTag", v)}><SelectTrigger id="ns-java"><SelectValue /></SelectTrigger>
                  <SelectContent>{JAVA_TAGS.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent></Select></div>
              <div className="flex flex-col gap-1.5"><Label htmlFor="ns-mem">Memoria JVM</Label><Input id="ns-mem" value={form.memory} onChange={(e) => set("memory", e.target.value)} placeholder="4G" pattern="[1-9][0-9]*[MmGg]" title="Ej. 4G o 512M" required /></div>
              <div className="flex flex-col gap-1.5"><Label htmlFor="ns-port">Puerto (vacío = automático)</Label><Input id="ns-port" value={form.port} onChange={(e) => set("port", e.target.value)} placeholder="25565" inputMode="numeric" aria-invalid={portInvalid} />
                {portInvalid && <p className="text-xs text-red-400">Debe ser un número entre 1 y 65535.</p>}</div>
            </div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.start} onChange={(e) => set("start", e.target.checked)} /> Arrancar al crear</label>
            {create.error && <p role="alert" className="text-sm text-red-400">{create.error.message}</p>}
            <Button type="submit" disabled={!form.nodeId || !form.name.trim() || portInvalid || create.isPending}>{create.isPending ? "Creando…" : "Crear servidor"}</Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
