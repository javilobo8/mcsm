import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import { proxiedImage } from "./adapter.js";

/** Longest description accepted before parsing (bytes of UTF-8); the rest is cut. */
export const DESCRIPTION_MAX_BYTES = 512 * 1024;

const LINK_ATTRS = { target: "_blank", rel: "noopener noreferrer" } as const;

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "b", "em", "i", "u", "s", "del", "code", "pre", "blockquote",
    "ul", "ol", "li", "a", "img", "table", "thead", "tbody", "tr", "th", "td", "details", "summary", "span", "div", "center",
  ],
  // target/rel are only ever the ones transformTags sets (the source's are replaced).
  allowedAttributes: { a: ["href", "target", "rel"], img: ["src", "alt", "width", "height"], td: ["colspan", "rowspan"], th: ["colspan", "rowspan"] },
  allowedSchemes: ["http", "https"],
  allowedSchemesByTag: {},
  allowedSchemesAppliedToAttributes: ["href", "src"],
  allowProtocolRelative: false,
  disallowedTagsMode: "discard",
  // Dropped with their text, not just unwrapped.
  nonTextTags: ["script", "style", "textarea", "option", "noscript", "iframe", "svg", "math", "object", "template", "title"],
  transformTags: {
    a: (_tag, attribs) => ({ tagName: "a", attribs: { ...(attribs.href ? { href: attribs.href } : {}), ...LINK_ATTRS } }),
    img: (_tag, attribs) => {
      const src = attribs.src ?? "";
      const proxied = proxiedImage(src);
      if (proxied) {
        const keep: Record<string, string> = { src: proxied };
        for (const k of ["alt", "width", "height"] as const) if (attribs[k] !== undefined) keep[k] = attribs[k];
        return { tagName: "img", attribs: keep };
      }
      // A foreign image would make the browser load a third-party URL: it becomes a link instead.
      return { tagName: "a", attribs: { href: src, ...LINK_ATTRS }, text: attribs.alt || "image" };
    },
  },
};

/** Project description (Modrinth Markdown or CurseForge HTML) → HTML that is safe to inject in the panel. */
export function descriptionHtml(source: { markdown: string } | { html: string }): string {
  const html = "markdown" in source
    ? marked.parse(cap(source.markdown), { async: false, gfm: true })
    : cap(source.html);
  return sanitizeHtml(html, OPTIONS);
}

function cap(s: string): string {
  const bytes = Buffer.from(s, "utf8");
  return bytes.byteLength <= DESCRIPTION_MAX_BYTES ? s : bytes.subarray(0, DESCRIPTION_MAX_BYTES).toString("utf8");
}
