import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useNavigate } from "@tanstack/react-router";
import { LayoutDashboard, ListChecks, Server, LogOut, Plus, LayoutTemplate, Bell, Settings, Menu } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Wordmark } from "@/components/logo";
import { api } from "@/lib/api";
import { useLive } from "@/hooks/use-live";

const nav = [
  { to: "/", label: "Servers", icon: LayoutDashboard },
  { to: "/nodes", label: "Nodes", icon: Server },
  { to: "/templates", label: "Templates", icon: LayoutTemplate },
  { to: "/jobs", label: "Jobs", icon: ListChecks }, // plan-4
  { to: "/events", label: "Events", icon: Bell }, // plan-9
  { to: "/settings", label: "Settings", icon: Settings }, // plan-9
] as const;

const navItem =
  "relative flex items-center gap-2.5 rounded-sm px-3 py-2 text-sm text-fog transition-colors hover:bg-bedrock-2/70 hover:text-bone " +
  "[&.active]:bg-bedrock-2 [&.active]:font-medium [&.active]:text-bone " +
  "before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:bg-grass before:opacity-0 [&.active]:before:opacity-100";

/** Logo, sections, “New server” and sign out: the desktop sidebar and the mobile menu share it. */
function SidebarBody({ onNavigate, onLogout }: { onNavigate?: () => void; onLogout: () => void }) {
  return (
    <>
      <nav aria-label="Main" className="flex flex-col gap-0.5">
        {nav.map((n) => (
          <Link key={n.to} to={n.to} onClick={onNavigate} className={navItem} activeOptions={{ exact: n.to === "/" }}>
            <n.icon className="size-4 shrink-0" aria-hidden="true" /> {n.label}
          </Link>
        ))}
      </nav>
      <Link to="/servers/new" onClick={onNavigate} className="block-btn block-grass mt-5 flex h-9 items-center justify-center gap-2 text-sm font-semibold text-primary-foreground">
        <Plus className="size-4" aria-hidden="true" /> New server
      </Link>
      <div className="mt-auto border-t border-sidebar-border pt-3">
        <button type="button" onClick={onLogout} className="flex w-full cursor-pointer items-center gap-2.5 rounded-sm px-3 py-2 text-sm text-fog transition-colors hover:bg-bedrock-2/70 hover:text-bone">
          <LogOut className="size-4" aria-hidden="true" /> Sign out
        </button>
      </div>
    </>
  );
}

export function Layout() {
  useLive(); // a single realtime bind for the whole authenticated app
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [menuOpen, setMenuOpen] = useState(false);
  const logout = async () => {
    setMenuOpen(false);
    try { await api.post("/api/auth/logout"); } catch { /* the session may have already expired: we leave anyway */ }
    queryClient.clear();
    await navigate({ to: "/login", search: {} });
  };
  return (
    <div className="flex h-full flex-col bg-background text-foreground md:flex-row">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar px-3 pb-4 md:flex">
        <Link to="/" className="mb-4 flex h-16 items-center rounded-sm px-2" aria-label="MC Server Manager, servers">
          <Wordmark />
        </Link>
        <SidebarBody onLogout={() => void logout()} />
      </aside>

      {/* Narrow screens: a top bar with the menu in a sheet. */}
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-sidebar-border bg-sidebar px-4 md:hidden">
        <Link to="/" className="rounded-sm" aria-label="MC Server Manager, servers">
          <Wordmark />
        </Link>
        <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
          <SheetTrigger asChild>
            <button type="button" className="inline-flex size-9 items-center justify-center rounded-sm text-bone" aria-label="Open the menu">
              <Menu className="size-5" aria-hidden="true" />
            </button>
          </SheetTrigger>
          <SheetContent side="left" className="w-[min(18rem,85vw)] gap-0 border-sidebar-border bg-sidebar px-3 pb-4">
            <SheetTitle className="mb-4 flex h-14 items-center px-2">
              <Wordmark />
            </SheetTitle>
            <SheetDescription className="sr-only">Panel navigation</SheetDescription>
            <SidebarBody onNavigate={() => setMenuOpen(false)} onLogout={() => void logout()} />
          </SheetContent>
        </Sheet>
      </header>

      <main className="min-w-0 flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-[1400px]"><Outlet /></div>
      </main>
    </div>
  );
}
