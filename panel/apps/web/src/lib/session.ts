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
