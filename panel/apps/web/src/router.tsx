import { type ErrorComponentProps, createRootRoute, createRoute, createRouter, redirect, Outlet } from "@tanstack/react-router";
import { api, type AuthStatus } from "./lib/api";
import { Layout } from "./components/layout";
import { LoginPage } from "./routes/login";
import { DashboardPage } from "./routes/dashboard";
import { NodesPage } from "./routes/nodes";
import { NewServerPage } from "./routes/new-server";
import { parseNewServerSearch } from "./lib/wizard";
import { ServerPage } from "./routes/server";
import { TemplatesPage } from "./routes/templates";
import { EditTemplatePage, NewTemplatePage } from "./routes/template-edit";

const getStatus = () => api.get<AuthStatus>("/api/auth/status");

function RouteError({ error, reset }: ErrorComponentProps) {
  return (
    <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-lg font-semibold">Algo ha fallado</p>
      <p className="text-sm text-muted-foreground">{error instanceof Error ? error.message : "Error inesperado"}</p>
      <button type="button" className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent" onClick={reset}>Reintentar</button>
    </div>
  );
}

const rootRoute = createRootRoute({ component: () => <Outlet />, errorComponent: RouteError });

const loginRoute = createRoute({
  getParentRoute: () => rootRoute, path: "/login", component: LoginPage,
  validateSearch: (s: Record<string, unknown>): { redirect?: string } => (typeof s.redirect === "string" ? { redirect: s.redirect } : {}),
  beforeLoad: async () => { const s = await getStatus(); if (s.authenticated) throw redirect({ to: "/" }); return { configured: s.configured }; },
});

const appRoute = createRoute({
  getParentRoute: () => rootRoute, id: "app", component: Layout,
  beforeLoad: async () => { const s = await getStatus(); if (!s.authenticated) throw redirect({ to: "/login" }); },
});

export const dashboardRoute = createRoute({ getParentRoute: () => appRoute, path: "/", component: DashboardPage });
export const nodesRoute = createRoute({ getParentRoute: () => appRoute, path: "/nodes", component: NodesPage });
export const newServerRoute = createRoute({
  getParentRoute: () => appRoute, path: "/servers/new", component: NewServerPage,
  // plan-3: ?template=<id> abre el asistente con esa plantilla elegida.
  validateSearch: parseNewServerSearch,
});
export const serverRoute = createRoute({ getParentRoute: () => appRoute, path: "/servers/$serverId", component: ServerPage });
// ── plan-2 ──
// ── plan-3 ──
export const templatesRoute = createRoute({ getParentRoute: () => appRoute, path: "/templates", component: TemplatesPage });
export const newTemplateRoute = createRoute({ getParentRoute: () => appRoute, path: "/templates/new", component: NewTemplatePage });
export const templateRoute = createRoute({ getParentRoute: () => appRoute, path: "/templates/$templateId", component: EditTemplatePage });
// ── plan-4 ──
// ── plan-5 ──
// ── plan-6 ──
// ── plan-7 ──
// ── plan-8 ──
// ── plan-9 ──


const routeTree = rootRoute.addChildren([
  loginRoute,
  appRoute.addChildren([
    dashboardRoute,
    nodesRoute,
    newServerRoute,
    serverRoute,
    // ── plan-2 ──
    // ── plan-3 ──
    templatesRoute,
    newTemplateRoute,
    templateRoute,
    // ── plan-4 ──
    // ── plan-5 ──
    // ── plan-6 ──
    // ── plan-7 ──
    // ── plan-8 ──
    // ── plan-9 ──
  ]),
]);
export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register { router: typeof router }
}
