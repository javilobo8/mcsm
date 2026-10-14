import { useState } from "react";
import { useNavigate, useRouteContext, useSearch } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BlockMark } from "@/components/logo";
import { Ground } from "@/components/ground";
import { api, ApiError } from "@/lib/api";
import { hash01 } from "@/lib/noise";
import { safeRedirect } from "@/lib/session";

// A night sky like the website's hero: square stars, denser towards the top.
const STARS = Array.from({ length: 60 }, (_, i) => ({
  left: hash01(i, 1) * 100,
  top: hash01(i, 2) ** 1.6 * 70,
  size: hash01(i, 3) < 0.18 ? 3 : 2,
  opacity: 0.2 + hash01(i, 4) * 0.5,
}));

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
    <div className="relative isolate flex min-h-full flex-col overflow-hidden bg-gradient-to-b from-[#121823] via-[#11151b] to-deepslate text-foreground">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10">
        {STARS.map((s, i) => (
          <span key={i} className="absolute bg-bone" style={{ left: `${s.left}%`, top: `${s.top}%`, width: s.size, height: s.size, opacity: s.opacity }} />
        ))}
      </div>

      <main className="flex flex-1 flex-col items-center justify-center px-4 py-12">
        <div className="flex flex-col items-center text-center">
          <BlockMark className="size-16 drop-shadow-[0_8px_24px_rgb(114_192_78/0.25)]" />
          <h1 className="mt-5 font-pixel text-[2rem] leading-tight font-semibold tracking-tight text-bone">MC Server Manager</h1>
          <p className="mt-2 text-sm text-fog">{configured ? "Sign in to manage your servers." : "Create the administrator password to finish setting up the panel."}</p>
        </div>

        <form onSubmit={submit} className="mt-8 flex w-full max-w-sm flex-col gap-4 rounded-lg border border-cobble bg-bedrock/85 p-6 shadow-2xl shadow-black/40 backdrop-blur-sm">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="login-password">Password</Label>
            <Input id="login-password" type="password" autoFocus autoComplete={configured ? "current-password" : "new-password"} value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} required />
          </div>
          {!configured && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="login-confirm">Repeat the password</Label>
              <Input id="login-confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} minLength={8} required />
            </div>
          )}
          {!configured && setupTokenRequired && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="login-token">Setup token</Label>
              <Input id="login-token" className="font-mono" autoComplete="off" value={setupToken} onChange={(e) => setSetupToken(e.target.value)} required />
              <p className="text-xs text-muted-foreground">It is in the panel log: <code className="text-bone">docker compose logs panel</code>.</p>
            </div>
          )}
          {error && <p role="alert" className="text-sm text-bad">{error}</p>}
          <Button type="submit" size="lg" className="mt-1 w-full" disabled={busy}>{configured ? "Sign in" : "Save and sign in"}</Button>
        </form>
      </main>

      <Ground />
    </div>
  );
}
