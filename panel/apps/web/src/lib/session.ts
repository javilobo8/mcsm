import { ApiError } from "./api";

/** Un 401 fuera de los endpoints de auth significa sesión caducada. */
export function isSessionExpired(status: number, path: string): boolean {
  return status === 401 && !path.startsWith("/api/auth/");
}

/** TanStack Query: no reintentar errores 4xx (incluido 401); una sola repetición para el resto. */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
  return failureCount < 1;
}

/** Destino a conservar tras el login; nada para "/" ni "/login". */
export function loginRedirectFor(location: string): string | undefined {
  if (location === "/" || location === "" || location.startsWith("/login")) return undefined;
  return location;
}

/** Solo rutas internas: evita redirecciones abiertas (`//host`, `http://…`). */
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
 * Handler idempotente: varias peticiones 401 simultáneas provocan una sola navegación y,
 * si ya estamos en /login, ninguna (sin bucles).
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
 * Qué hacer con un 401 REST visto mientras se cambia la sesión (cambio de contraseña) cuando acaba el cambio:
 * éxito → la petición iba con la cookie vieja, se reintenta o invalida; fallo → la sesión sí se perdió.
 */
export function resolveHeld401(saw401: boolean, ok: boolean): "invalidate" | "unauthorized" | "none" {
  if (!saw401) return "none";
  return ok ? "invalidate" : "unauthorized";
}

/**
 * Filtro de los 401 REST: mientras hay retenciones (`hold`) el 401 solo se anota. Al soltar la última se decide con
 * `resolveHeld401`; un fallo notifica con `fire` (el éxito lo resuelve quien llama, invalidando sus consultas).
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
