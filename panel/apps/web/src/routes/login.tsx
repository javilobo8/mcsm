import { useState } from "react";
import { useNavigate, useRouteContext } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api, ApiError } from "@/lib/api";

export function LoginPage() {
  const { configured } = useRouteContext({ from: "/login" }) as { configured: boolean };
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.post(configured ? "/api/auth/login" : "/api/auth/setup", { password });
      await navigate({ to: "/" });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Error inesperado");
    } finally { setBusy(false); }
  };

  return (
    <div className="flex h-full items-center justify-center bg-zinc-950 text-zinc-100">
      <Card className="w-full max-w-sm">
        <CardHeader><CardTitle>{configured ? "Entrar" : "Crea tu contraseña de administrador"}</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={submit} className="flex flex-col gap-3">
            <Input type="password" autoFocus aria-label="Contraseña" placeholder="Contraseña" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} required />
            {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
            <Button type="submit" disabled={busy}>{configured ? "Entrar" : "Guardar y entrar"}</Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
