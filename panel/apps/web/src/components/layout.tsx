import { Link, Outlet, useNavigate } from "@tanstack/react-router";
import { LayoutDashboard, Server, LogOut, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

const nav = [
  { to: "/", label: "Servidores", icon: LayoutDashboard },
  { to: "/nodes", label: "Nodos", icon: Server },
] as const;

export function Layout() {
  const navigate = useNavigate();
  const logout = async () => { await api.post("/api/auth/logout"); await navigate({ to: "/login" }); };
  return (
    <div className="flex h-full bg-zinc-950 text-zinc-100">
      <aside className="flex w-56 flex-col border-r border-zinc-800 p-4">
        <div className="mb-6 text-lg font-semibold tracking-tight">MC Server Manager</div>
        <nav className="flex flex-1 flex-col gap-1">
          {nav.map((n) => (
            <Link key={n.to} to={n.to} className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-900 [&.active]:bg-zinc-800 [&.active]:text-white" activeOptions={{ exact: n.to === "/" }}>
              <n.icon className="size-4" /> {n.label}
            </Link>
          ))}
          <Link to="/servers/new" className="mt-2 flex items-center gap-2 rounded-md border border-dashed border-zinc-700 px-3 py-2 text-sm text-zinc-400 hover:border-zinc-500 hover:text-zinc-200">
            <Plus className="size-4" /> Nuevo servidor
          </Link>
        </nav>
        <Button variant="ghost" className="justify-start text-zinc-400" onClick={logout}><LogOut className="size-4" /> Salir</Button>
      </aside>
      <main className="flex-1 overflow-auto"><Outlet /></main>
    </div>
  );
}
