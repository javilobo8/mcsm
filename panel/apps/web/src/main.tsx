import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { router } from "./router";
import { setUnauthorizedHandler } from "./lib/api";
import { realtime } from "./lib/ws";
import { createUnauthorizedHandler, shouldRetry } from "./lib/session";
import "./index.css";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: shouldRetry, refetchOnWindowFocus: false } } });

const onUnauthorized = createUnauthorizedHandler({
  clearCache: () => queryClient.clear(),
  currentLocation: () => router.state.location.href,
  goToLogin: (redirect) => { void router.navigate({ to: "/login", search: redirect ? { redirect } : {} }); },
});
setUnauthorizedHandler(onUnauthorized);
realtime.onAuthLost(onUnauthorized);
// Al salir de /login (sesión nueva) se rearma el manejo de 401 y el WebSocket.
router.subscribe("onResolved", () => {
  if (!router.state.location.pathname.startsWith("/login")) { onUnauthorized.reset(); realtime.resume(); }
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
);
