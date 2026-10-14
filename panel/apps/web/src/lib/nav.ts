/**
 * Whether the sidebar entry `to` is the current section: its own page and the pages under it. Servers (`/`)
 * also covers every `/servers/…` page (a server, the new-server wizard).
 */
export function navActive(pathname: string, to: string): boolean {
  if (to === "/") return pathname === "/" || pathname.startsWith("/servers/");
  return pathname === to || pathname.startsWith(`${to}/`);
}
