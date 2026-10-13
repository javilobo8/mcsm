import { useState } from "react";
import { useNavigate, useRouteContext, useSearch } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api, ApiError } from "@/lib/api";
import { safeRedirect } from "@/lib/session";

export function LoginPage() {
  const { configured, setupTokenRequired } = useRouteContext({ from: "/login" }) as { configured: boolean; setupTokenRequired: boolean };
  const { redirect } = useSearch({ from: "/login" }) as { redirect?: string };
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!configured && password !== confirm) { setError("Las contraseñas no coinciden"); return; }
    setBusy(true); setError(null);
    try {
      await api.post(configured ? "/api/auth/login" : "/api/auth/setup", configured ? { password } : { password, ...(setupTokenRequired ? { setupToken: setupToken.trim() } : {}) });
      await navigate({ href: safeRedirect(redirect) });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Error inesperado");
    } finally { setBusy(false); }
  };

  return (
    <div className="flex h-full items-center justify-center bg-background text-foreground">
      <Card className="w-full max-w-sm">
        <CardHeader><CardTitle>{configured ? "Entrar" : "Crea tu contraseña de administrador"}</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={submit} className="flex flex-col gap-3">
            <Input type="password" autoFocus autoComplete={configured ? "current-password" : "new-password"} aria-label="Contraseña" placeholder="Contraseña" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} required />
            {!configured && (
              <Input type="password" autoComplete="new-password" aria-label="Repite la contraseña" placeholder="Repite la contraseña" value={confirm} onChange={(e) => setConfirm(e.target.value)} minLength={8} required />
            )}
            {!configured && setupTokenRequired && (
              <>
                <Input aria-label="Token de configuración" placeholder="Token de configuración" autoComplete="off" value={setupToken} onChange={(e) => setSetupToken(e.target.value)} required />
                <p className="text-xs text-muted-foreground">Está en el log del panel: <code>docker compose logs panel</code>.</p>
              </>
            )}
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <Button type="submit" disabled={busy}>{configured ? "Entrar" : "Guardar y entrar"}</Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
