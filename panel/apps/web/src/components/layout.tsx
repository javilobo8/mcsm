import { useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useNavigate } from "@tanstack/react-router";
import { LayoutDashboard, ListChecks, Server, LogOut, Plus, LayoutTemplate } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useLive } from "@/hooks/use-live";

const nav = [
  { to: "/", label: "Servidores", icon: LayoutDashboard },
  { to: "/nodes", label: "Nodos", icon: Server },
  { to: "/templates", label: "Plantillas", icon: LayoutTemplate },
  { to: "/jobs", label: "Jobs", icon: ListChecks }, // plan-4
] as const;

export function Layout() {
  useLive(); // un único bind del tiempo real para toda la app autenticada
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const logout = async () => {
    try { await api.post("/api/auth/logout"); } catch { /* la sesión puede haber caducado ya: salimos igualmente */ }
    queryClient.clear();
    await navigate({ to: "/login", search: {} });
  };
  return (
    <div className="flex h-full bg-background text-foreground">
      <aside className="flex w-56 flex-col border-r border-sidebar-border bg-sidebar p-4">
        <div className="mb-6 text-lg font-semibold tracking-tight">MC Server Manager</div>
        <nav className="flex flex-1 flex-col gap-1">
          {nav.map((n) => (
            <Link key={n.to} to={n.to} className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-sidebar-foreground/80 hover:bg-sidebar-accent [&.active]:bg-sidebar-accent [&.active]:text-sidebar-accent-foreground" activeOptions={{ exact: n.to === "/" }}>
              <n.icon className="size-4" /> {n.label}
            </Link>
          ))}
          <Link to="/servers/new" className="mt-2 flex items-center gap-2 rounded-md border border-dashed border-border px-3 py-2 text-sm text-muted-foreground hover:border-ring hover:text-foreground">
            <Plus className="size-4" /> Nuevo servidor
          </Link>
        </nav>
        <Button variant="ghost" className="justify-start text-muted-foreground" onClick={logout}><LogOut className="size-4" /> Salir</Button>
      </aside>
      <main className="flex-1 overflow-auto"><Outlet /></main>
    </div>
  );
}
