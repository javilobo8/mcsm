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
    if (!configured && password !== confirm) { setError("The passwords do not match"); return; }
    setBusy(true); setError(null);
    try {
      await api.post(configured ? "/api/auth/login" : "/api/auth/setup", configured ? { password } : { password, ...(setupTokenRequired ? { setupToken: setupToken.trim() } : {}) });
      await navigate({ href: safeRedirect(redirect) });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Unexpected error");
    } finally { setBusy(false); }
  };

  return (
    <div className="flex h-full items-center justify-center bg-background text-foreground">
      <Card className="w-full max-w-sm">
        <CardHeader><CardTitle>{configured ? "Sign in" : "Create your administrator password"}</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={submit} className="flex flex-col gap-3">
            <Input type="password" autoFocus autoComplete={configured ? "current-password" : "new-password"} aria-label="Password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} required />
            {!configured && (
              <Input type="password" autoComplete="new-password" aria-label="Repeat the password" placeholder="Repeat the password" value={confirm} onChange={(e) => setConfirm(e.target.value)} minLength={8} required />
            )}
            {!configured && setupTokenRequired && (
              <>
                <Input aria-label="Setup token" placeholder="Setup token" autoComplete="off" value={setupToken} onChange={(e) => setSetupToken(e.target.value)} required />
                <p className="text-xs text-muted-foreground">It is in the panel log: <code>docker compose logs panel</code>.</p>
              </>
            )}
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <Button type="submit" disabled={busy}>{configured ? "Sign in" : "Save and sign in"}</Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
