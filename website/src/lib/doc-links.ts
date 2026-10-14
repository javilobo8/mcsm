const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/**
 * Reads a link inside a compiled docs page: "<base>docs/<slug>/#<anchor>" (another page) or "#<anchor>"
 * (the current page, `slug` undefined). Anything else (external, assets) is null and left to the browser.
 */
export function parseDocsHref(href: string, base: string): { slug: string | undefined; hash: string | undefined } | null {
  if (href.startsWith("#")) return href.length > 1 ? { slug: undefined, hash: decode(href.slice(1)) } : null;
  if (!href.startsWith(`${base}docs/`)) return null;
  const m = /^([^/#?]+)\/?(?:#(.*))?$/.exec(href.slice(`${base}docs/`.length));
  if (!m) return null;
  return { slug: m[1]!, hash: m[2] ? decode(m[2]) : undefined };
}
