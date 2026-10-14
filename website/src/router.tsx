import { createRootRoute, createRoute, createRouter, lazyRouteComponent, Outlet, redirect } from "@tanstack/react-router";
import { HomePage } from "./routes/home";
import { NotFoundPage } from "./routes/not-found";

const rootRoute = createRootRoute({ component: () => <Outlet />, notFoundComponent: NotFoundPage });

const homeRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: HomePage });

const docsIndexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/docs",
  beforeLoad: () => {
    throw redirect({ to: "/docs/$slug/", params: { slug: "introduction" }, replace: true });
  },
});

export const docRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/docs/$slug",
  component: lazyRouteComponent(() => import("./routes/docs"), "DocsPage"),
});

const routeTree = rootRoute.addChildren([homeRoute, docsIndexRoute, docRoute]);

export const router = createRouter({
  routeTree,
  // "/mcsm/" → "/mcsm"; "/" → "/".
  basepath: import.meta.env.BASE_URL.replace(/\/$/, "") || "/",
  trailingSlash: "always",
  defaultPreload: "intent",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
