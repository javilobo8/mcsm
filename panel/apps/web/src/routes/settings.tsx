import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useBlocker } from "@tanstack/react-router";
import type { ConnectAddress, SettingsDto } from "@mcsm/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CurseForgeKeyNotice } from "@/components/spec-form/curseforge-key";
import { PAGE, PageHeader } from "@/components/page-header";
import { cn } from "@/lib/utils";
import { api, ApiError, holdUnauthorized } from "@/lib/api";
import { realtime } from "@/lib/ws";
import { connectForm, parseConnectAddress, parsePortRange, parsePublicUrl, passwordFormError, portRangeForm, publicUrlNote, settingsLeaveWarning } from "@/lib/settings";
import { settingsKey, useSettings } from "@/hooks/use-settings";

const errText = (e: unknown) => (e instanceof ApiError ? e.message : "Unexpected error");

export function SettingsPage() {
  const q = useSettings();
  if (q.isPending) return <p className="p-4 sm:p-6 lg:p-8 text-muted-foreground">Loading settings…</p>;
  if (q.isError) return <p role="alert" className="p-4 sm:p-6 lg:p-8 text-bad">Could not load the settings: {q.error.message}</p>;
  return <SettingsForms settings={q.data} />;
}

function SettingsForms({ settings }: { settings: SettingsDto }) {
  const qc = useQueryClient();
  const [pw, setPw] = useState({ current: "", next: "", repeat: "" });
  const [url, setUrl] = useState(settings.publicUrlSource === "settings" ? settings.publicUrl : "");
  const [range, setRange] = useState(portRangeForm(settings.gamePortRange));
  const [connect, setConnect] = useState(connectForm(settings.connectAddress));
  const [localErr, setLocalErr] = useState<{ pw?: string; url?: string; range?: string; connect?: string }>({});
  const savedUrl = settings.publicUrlSource === "settings" ? settings.publicUrl : "";
  const dirty = pw.current !== "" || pw.next !== "" || pw.repeat !== "" || url !== savedUrl
    || range.from !== String(settings.gamePortRange.from) || range.to !== String(settings.gamePortRange.to)
    || connect.host !== connectForm(settings.connectAddress).host || connect.port !== connectForm(settings.connectAddress).port;
  const leave = settingsLeaveWarning(dirty);
  const lastLeave = useRef(leave); // the text does not disappear while the dialog closes
  if (leave) lastLeave.current = leave;
  const blocker = useBlocker({ shouldBlockFn: () => true, disabled: !dirty, enableBeforeUnload: () => dirty, withResolver: true });

  const onSaved = (s: SettingsDto) => qc.setQueryData(settingsKey, s);
  const password = useMutation({
    // The server revokes all sessions and closes their WS with 4401 (ours too): it is not a lost session.
    mutationFn: async () => {
      const settle = realtime.expectSessionChange();
      const release = holdUnauthorized(); // an in-flight REST 401 carries the old cookie: it is not a lost session
      try { await api.post("/api/auth/password", { currentPassword: pw.current, newPassword: pw.next }); } catch (e) { settle(false); release(false); throw e; }
      settle(true);
      if (release(true) === "invalidate") void qc.invalidateQueries();
    },
    onSuccess: () => setPw({ current: "", next: "", repeat: "" }),
  });
  const saveUrl = useMutation({ mutationFn: (publicUrl: string) => api.put<SettingsDto>("/api/settings", { publicUrl }), onSuccess: (s) => { onSaved(s); setUrl(s.publicUrlSource === "settings" ? s.publicUrl : ""); } });
  const saveConnect = useMutation({ mutationFn: (connectAddress: ConnectAddress) => api.put<SettingsDto>("/api/settings", { connectAddress }), onSuccess: (s) => { onSaved(s); setConnect(connectForm(s.connectAddress)); } });
  const saveRange = useMutation({ mutationFn: (gamePortRange: { from: number; to: number }) => api.put<SettingsDto>("/api/settings", { gamePortRange }), onSuccess: (s) => { onSaved(s); setRange(portRangeForm(s.gamePortRange)); } });

  return (
    <div className={cn(PAGE, "max-w-4xl")}>
      <PageHeader title="Settings" description="Your password, the panel's address for new nodes, the address players use to join, the game port range and the CurseForge key." />

      <Card>
        <CardHeader><CardTitle>Administrator password</CardTitle></CardHeader>
        <CardContent>
          <form className="grid gap-3 sm:grid-cols-3" onSubmit={(e) => { e.preventDefault(); password.reset(); const err = passwordFormError(pw); setLocalErr((o) => ({ ...o, pw: err ?? undefined })); if (!err) password.mutate(); }}>
            <div className="flex flex-col gap-1.5"><Label htmlFor="set-pw-current">Current</Label><Input id="set-pw-current" type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></div>
            <div className="flex flex-col gap-1.5"><Label htmlFor="set-pw-next">New</Label><Input id="set-pw-next" type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} /></div>
            <div className="flex flex-col gap-1.5"><Label htmlFor="set-pw-repeat">Repeat the new one</Label><Input id="set-pw-repeat" type="password" autoComplete="new-password" value={pw.repeat} onChange={(e) => setPw({ ...pw, repeat: e.target.value })} /></div>
            <div className="flex items-center gap-3 sm:col-span-3">
              <Button type="submit" disabled={password.isPending}>{password.isPending ? "Saving…" : "Change password"}</Button>
              {(localErr.pw || password.error) && <span role="alert" className="text-sm text-bad">{localErr.pw ?? errText(password.error)}</span>}
              {password.isSuccess && <span role="status" className="text-sm text-ok">Password changed. The other sessions have been closed.</span>}
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Panel URL</CardTitle></CardHeader>
        <CardContent>
          <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); saveUrl.reset(); const r = parsePublicUrl(url); setLocalErr((o) => ({ ...o, url: r.ok ? undefined : r.error })); if (r.ok) saveUrl.mutate(r.value); }}>
            <Label htmlFor="set-url">URL the agents use to reach the panel (goes in the enrollment command)</Label>
            <Input id="set-url" className="font-mono" placeholder={settings.envPublicUrl || "http://192.168.1.10:8080"} value={url} onChange={(e) => setUrl(e.target.value)} />
            <p className="text-xs text-muted-foreground">{publicUrlNote(settings)}</p>
            <div className="flex items-center gap-3">
              <Button type="submit" disabled={saveUrl.isPending}>Save URL</Button>
              {(localErr.url || saveUrl.error) && <span role="alert" className="text-sm text-bad">{localErr.url ?? errText(saveUrl.error)}</span>}
              {saveUrl.isSuccess && <span role="status" className="text-sm text-ok">Saved.</span>}
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Game ports</CardTitle></CardHeader>
        <CardContent>
          <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); saveRange.reset(); const r = parsePortRange(range); setLocalErr((o) => ({ ...o, range: r.ok ? undefined : r.error })); if (r.ok) saveRange.mutate(r.value); }}>
            <div className="flex items-end gap-3">
              <div className="flex flex-col gap-1.5"><Label htmlFor="set-port-from">From</Label><Input id="set-port-from" className="w-32" inputMode="numeric" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></div>
              <div className="flex flex-col gap-1.5"><Label htmlFor="set-port-to">To</Label><Input id="set-port-to" className="w-32" inputMode="numeric" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></div>
              <Button type="submit" disabled={saveRange.isPending}>Save range</Button>
            </div>
            <p className="text-xs text-muted-foreground">The panel assigns from here the port of new servers that do not choose one (default {settings.defaultGamePortRange.from}–{settings.defaultGamePortRange.to}). It does not change the port of servers that already exist.</p>
            {(localErr.range || saveRange.error) && <p role="alert" className="text-sm text-bad">{localErr.range ?? errText(saveRange.error)}</p>}
            {saveRange.isSuccess && <p role="status" className="text-sm text-ok">Saved.</p>}
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Connection address</CardTitle></CardHeader>
        <CardContent>
          <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); saveConnect.reset(); const r = parseConnectAddress(connect); setLocalErr((o) => ({ ...o, connect: r.ok ? undefined : r.error })); if (r.ok) saveConnect.mutate(r.value); }}>
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex min-w-0 flex-1 flex-col gap-1.5"><Label htmlFor="set-connect-host">Address</Label><Input id="set-connect-host" className="font-mono" placeholder="mc.example.com" value={connect.host} onChange={(e) => setConnect({ ...connect, host: e.target.value })} /></div>
              <div className="flex flex-col gap-1.5"><Label htmlFor="set-connect-port">External port</Label><Input id="set-connect-port" className="w-32" inputMode="numeric" placeholder="server's" value={connect.port} onChange={(e) => setConnect({ ...connect, port: e.target.value })} /></div>
              <Button type="submit" disabled={saveConnect.isPending}>Save address</Button>
            </div>
            <p className="text-xs text-muted-foreground">What players type in Minecraft, shown next to each server in the list: your domain or public IP and the port forwarded on your router (e.g. 55567). Empty port = each server's own port. Servers that join through mc-router show their hostname with this port (or the router's).</p>
            {(localErr.connect || saveConnect.error) && <p role="alert" className="text-sm text-bad">{localErr.connect ?? errText(saveConnect.error)}</p>}
            {saveConnect.isSuccess && <p role="status" className="text-sm text-ok">Saved.</p>}
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>CurseForge</CardTitle></CardHeader>
        <CardContent><CurseForgeKeyNotice /></CardContent>
      </Card>

      <ConfirmDialog open={blocker.status === "blocked"} title={lastLeave.current?.title ?? "Leave"} description={lastLeave.current?.description ?? ""}
        confirmLabel={lastLeave.current?.confirmLabel ?? "Leave"} cancelLabel="Stay" onConfirm={() => blocker.proceed?.()} onCancel={() => blocker.reset?.()} />
    </div>
  );
}
