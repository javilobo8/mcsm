import { createRootRoute, createRoute, createRouter, redirect, Outlet } from "@tanstack/react-router";
import { api, type AuthStatus } from "./lib/api";
import { Layout } from "./components/layout";
import { LoginPage } from "./routes/login";
import { DashboardPage } from "./routes/dashboard";
import { NodesPage } from "./routes/nodes";
import { NewServerPage } from "./routes/new-server";
import { ServerPage } from "./routes/server";

const getStatus = () => api.get<AuthStatus>("/api/auth/status");

const rootRoute = createRootRoute({ component: () => <Outlet /> });

const loginRoute = createRoute({
  getParentRoute: () => rootRoute, path: "/login", component: LoginPage,
  beforeLoad: async () => { const s = await getStatus(); if (s.authenticated) throw redirect({ to: "/" }); return { configured: s.configured }; },
});

const appRoute = createRoute({
  getParentRoute: () => rootRoute, id: "app", component: Layout,
  beforeLoad: async () => { const s = await getStatus(); if (!s.authenticated) throw redirect({ to: "/login" }); },
});

export const dashboardRoute = createRoute({ getParentRoute: () => appRoute, path: "/", component: DashboardPage });
export const nodesRoute = createRoute({ getParentRoute: () => appRoute, path: "/nodes", component: NodesPage });
export const newServerRoute = createRoute({ getParentRoute: () => appRoute, path: "/servers/new", component: NewServerPage });
export const serverRoute = createRoute({ getParentRoute: () => appRoute, path: "/servers/$serverId", component: ServerPage });

const routeTree = rootRoute.addChildren([loginRoute, appRoute.addChildren([dashboardRoute, nodesRoute, newServerRoute, serverRoute])]);
export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register { router: typeof router }
}
