import { ApiError } from "./api";

/** A 401 outside the auth endpoints means an expired session. */
export function isSessionExpired(status: number, path: string): boolean {
  return status === 401 && !path.startsWith("/api/auth/");
}

/** TanStack Query: do not retry 4xx errors (401 included); a single retry for the rest. */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
  return failureCount < 1;
}

/** Destination to keep after login; nothing for "/" or "/login". */
export function loginRedirectFor(location: string): string | undefined {
  if (location === "/" || location === "" || location.startsWith("/login")) return undefined;
  return location;
}

/** Internal paths only: avoids open redirects (`//host`, `http://…`). */
export function safeRedirect(target: unknown): string {
  if (typeof target !== "string" || !target.startsWith("/") || target.startsWith("//") || target.startsWith("/\\")) return "/";
  return target;
}

interface HandlerDeps {
  clearCache: () => void;
  currentLocation: () => string;
  goToLogin: (redirect: string | undefined) => void;
}

/**
 * Idempotent handler: several simultaneous 401 requests cause a single navigation and,
 * if we are already on /login, none (no loops).
 */
export function createUnauthorizedHandler(deps: HandlerDeps) {
  let handling = false;
  const handler = () => {
    const loc = deps.currentLocation();
    if (handling || loc.startsWith("/login")) return;
    handling = true;
    deps.clearCache();
    deps.goToLogin(loginRedirectFor(loc));
  };
  handler.reset = () => { handling = false; };
  return handler;
}

/**
 * What to do with a REST 401 seen while the session is being changed (password change) when the change ends:
 * success → the request carried the old cookie, it is retried or invalidated; failure → the session really was lost.
 */
export function resolveHeld401(saw401: boolean, ok: boolean): "invalidate" | "unauthorized" | "none" {
  if (!saw401) return "none";
  return ok ? "invalidate" : "unauthorized";
}

/**
 * Filter for REST 401s: while there are holds (`hold`) the 401 is only noted. When the last one is released it is decided with
 * `resolveHeld401`; a failure notifies with `fire` (success is resolved by the caller, invalidating its queries).
 */
export function createUnauthorizedGate(fire: () => void) {
  let holds = 0; let saw = false; let anyOk = false;
  return {
    report(): void { if (holds > 0) saw = true; else fire(); },
    hold(): (ok: boolean) => "invalidate" | "unauthorized" | "none" {
      if (holds === 0) { saw = false; anyOk = false; }
      holds++;
      let released = false;
      return (ok) => {
        if (released) return "none";
        released = true; holds--;
        if (ok) anyOk = true;
        if (holds > 0) return "none";
        const r = resolveHeld401(saw, anyOk);
        saw = false;
        if (r === "unauthorized") fire();
        return r;
      };
    },
  };
}
