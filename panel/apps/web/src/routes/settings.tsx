import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useBlocker } from "@tanstack/react-router";
import type { SettingsDto } from "@mcsm/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CurseForgeKeyNotice } from "@/components/spec-form/curseforge-key";
import { api, ApiError } from "@/lib/api";
import { realtime } from "@/lib/ws";
import { parsePortRange, parsePublicUrl, passwordFormError, portRangeForm, publicUrlNote, settingsLeaveWarning } from "@/lib/settings";
import { settingsKey, useSettings } from "@/hooks/use-settings";

const errText = (e: unknown) => (e instanceof ApiError ? e.message : "Error inesperado");

export function SettingsPage() {
  const q = useSettings();
  if (q.isPending) return <p className="p-6 text-muted-foreground">Cargando ajustes…</p>;
  if (q.isError) return <p role="alert" className="p-6 text-red-400">No se pudieron cargar los ajustes: {q.error.message}</p>;
  return <SettingsForms settings={q.data} />;
}

function SettingsForms({ settings }: { settings: SettingsDto }) {
  const qc = useQueryClient();
  const [pw, setPw] = useState({ current: "", next: "", repeat: "" });
  const [url, setUrl] = useState(settings.publicUrlSource === "settings" ? settings.publicUrl : "");
  const [range, setRange] = useState(portRangeForm(settings.gamePortRange));
  const [localErr, setLocalErr] = useState<{ pw?: string; url?: string; range?: string }>({});
  const savedUrl = settings.publicUrlSource === "settings" ? settings.publicUrl : "";
  const dirty = pw.current !== "" || pw.next !== "" || pw.repeat !== "" || url !== savedUrl
    || range.from !== String(settings.gamePortRange.from) || range.to !== String(settings.gamePortRange.to);
  const leave = settingsLeaveWarning(dirty);
  const lastLeave = useRef(leave); // el texto no desaparece mientras se cierra el diálogo
  if (leave) lastLeave.current = leave;
  const blocker = useBlocker({ shouldBlockFn: () => true, disabled: !dirty, enableBeforeUnload: () => dirty, withResolver: true });

  const onSaved = (s: SettingsDto) => qc.setQueryData(settingsKey, s);
  const password = useMutation({
    // El servidor revoca todas las sesiones y cierra sus WS con 4401 (también el nuestro): no es una sesión perdida.
    mutationFn: async () => {
      const settle = realtime.expectSessionChange();
      try { await api.post("/api/auth/password", { currentPassword: pw.current, newPassword: pw.next }); } catch (e) { settle(false); throw e; }
      settle(true);
    },
    onSuccess: () => setPw({ current: "", next: "", repeat: "" }),
  });
  const saveUrl = useMutation({ mutationFn: (publicUrl: string) => api.put<SettingsDto>("/api/settings", { publicUrl }), onSuccess: (s) => { onSaved(s); setUrl(s.publicUrlSource === "settings" ? s.publicUrl : ""); } });
  const saveRange = useMutation({ mutationFn: (gamePortRange: { from: number; to: number }) => api.put<SettingsDto>("/api/settings", { gamePortRange }), onSuccess: (s) => { onSaved(s); setRange(portRangeForm(s.gamePortRange)); } });

  return (
    <div className="flex max-w-3xl flex-col gap-4 p-6">
      <h1 className="text-2xl font-semibold">Ajustes</h1>

      <Card>
        <CardHeader><CardTitle>Contraseña de administrador</CardTitle></CardHeader>
        <CardContent>
          <form className="grid gap-3 sm:grid-cols-3" onSubmit={(e) => { e.preventDefault(); password.reset(); const err = passwordFormError(pw); setLocalErr((o) => ({ ...o, pw: err ?? undefined })); if (!err) password.mutate(); }}>
            <div className="flex flex-col gap-1.5"><Label htmlFor="set-pw-current">Actual</Label><Input id="set-pw-current" type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></div>
            <div className="flex flex-col gap-1.5"><Label htmlFor="set-pw-next">Nueva</Label><Input id="set-pw-next" type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} /></div>
            <div className="flex flex-col gap-1.5"><Label htmlFor="set-pw-repeat">Repite la nueva</Label><Input id="set-pw-repeat" type="password" autoComplete="new-password" value={pw.repeat} onChange={(e) => setPw({ ...pw, repeat: e.target.value })} /></div>
            <div className="flex items-center gap-3 sm:col-span-3">
              <Button type="submit" disabled={password.isPending}>{password.isPending ? "Guardando…" : "Cambiar contraseña"}</Button>
              {(localErr.pw || password.error) && <span role="alert" className="text-sm text-red-400">{localErr.pw ?? errText(password.error)}</span>}
              {password.isSuccess && <span role="status" className="text-sm text-emerald-400">Contraseña cambiada. Las demás sesiones se han cerrado.</span>}
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>URL del panel</CardTitle></CardHeader>
        <CardContent>
          <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); saveUrl.reset(); const r = parsePublicUrl(url); setLocalErr((o) => ({ ...o, url: r.ok ? undefined : r.error })); if (r.ok) saveUrl.mutate(r.value); }}>
            <Label htmlFor="set-url">URL con la que los agentes llegan al panel (va en el comando de alta)</Label>
            <Input id="set-url" className="font-mono" placeholder={settings.envPublicUrl || "http://192.168.1.10:8080"} value={url} onChange={(e) => setUrl(e.target.value)} />
            <p className="text-xs text-muted-foreground">{publicUrlNote(settings)}</p>
            <div className="flex items-center gap-3">
              <Button type="submit" disabled={saveUrl.isPending}>Guardar URL</Button>
              {(localErr.url || saveUrl.error) && <span role="alert" className="text-sm text-red-400">{localErr.url ?? errText(saveUrl.error)}</span>}
              {saveUrl.isSuccess && <span role="status" className="text-sm text-emerald-400">Guardada.</span>}
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Puertos de juego</CardTitle></CardHeader>
        <CardContent>
          <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); saveRange.reset(); const r = parsePortRange(range); setLocalErr((o) => ({ ...o, range: r.ok ? undefined : r.error })); if (r.ok) saveRange.mutate(r.value); }}>
            <div className="flex items-end gap-3">
              <div className="flex flex-col gap-1.5"><Label htmlFor="set-port-from">Desde</Label><Input id="set-port-from" className="w-32" inputMode="numeric" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></div>
              <div className="flex flex-col gap-1.5"><Label htmlFor="set-port-to">Hasta</Label><Input id="set-port-to" className="w-32" inputMode="numeric" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></div>
              <Button type="submit" disabled={saveRange.isPending}>Guardar rango</Button>
            </div>
            <p className="text-xs text-muted-foreground">El panel reparte de aquí el puerto de los servidores nuevos que no lo eligen (por defecto {settings.defaultGamePortRange.from}–{settings.defaultGamePortRange.to}). No cambia el de los que ya existen.</p>
            {(localErr.range || saveRange.error) && <p role="alert" className="text-sm text-red-400">{localErr.range ?? errText(saveRange.error)}</p>}
            {saveRange.isSuccess && <p role="status" className="text-sm text-emerald-400">Guardado.</p>}
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>CurseForge</CardTitle></CardHeader>
        <CardContent><CurseForgeKeyNotice /></CardContent>
      </Card>

      <ConfirmDialog open={blocker.status === "blocked"} title={lastLeave.current?.title ?? "Salir"} description={lastLeave.current?.description ?? ""}
        confirmLabel={lastLeave.current?.confirmLabel ?? "Salir"} cancelLabel="Quedarme" onConfirm={() => blocker.proceed?.()} onCancel={() => blocker.reset?.()} />
    </div>
  );
}
