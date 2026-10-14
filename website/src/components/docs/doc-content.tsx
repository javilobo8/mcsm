import { useLayoutEffect, useRef, type MouseEvent } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { copyText } from "@/lib/clipboard";
import { parseDocsHref } from "@/lib/doc-links";

const COPY_ICON =
  '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';

/** Adds the label (file or language) and a copy button to every compiled `.code-block`. */
function enhanceCodeBlocks(root: HTMLElement) {
  for (const block of root.querySelectorAll<HTMLElement>(".code-block")) {
    if (block.querySelector(":scope > .code-toolbar")) continue;
    const bar = document.createElement("div");
    bar.className = "code-toolbar";
    const label = document.createElement("span");
    label.className = block.dataset.file ? "code-label code-label-file" : "code-label";
    label.textContent = block.dataset.file ?? (block.dataset.lang === "text" ? "" : (block.dataset.lang ?? ""));
    const button = document.createElement("button");
    button.type = "button";
    button.className = "code-copy";
    button.innerHTML = `${COPY_ICON}<span aria-live="polite">Copy</span>`;
    bar.append(label, button);
    block.prepend(bar);
  }
}

const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** A compiled docs page. Its HTML is our own content, compiled at build time. */
export function DocContent({ html, slug }: { html: string; slug: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const hash = useLocation({ select: (l) => l.hash });

  useLayoutEffect(() => {
    if (ref.current) enhanceCodeBlocks(ref.current);
  }, [html]);

  // Scroll to the anchor once the page is in the DOM (the router's own attempt can run before the
  // lazily loaded docs render on a first visit), and again when the fonts arrive if the reader hasn't moved.
  useLayoutEffect(() => {
    if (!hash) return;
    const id = decode(hash);
    const target = document.getElementById(id);
    if (!target) return;
    target.scrollIntoView();
    const settled = window.scrollY;
    let cancelled = false;
    void document.fonts?.ready.then(() => {
      if (!cancelled && Math.abs(window.scrollY - settled) < 2) document.getElementById(id)?.scrollIntoView();
    });
    return () => {
      cancelled = true;
    };
  }, [html, hash]);

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const el = e.target as HTMLElement;
    const copy = el.closest<HTMLButtonElement>("button.code-copy");
    if (copy) {
      const code = copy.closest(".code-block")?.querySelector("pre")?.textContent ?? "";
      void copyText(code).then((ok) => {
        const text = copy.querySelector("span");
        if (!text) return;
        text.textContent = ok ? "Copied" : "Copy failed";
        copy.dataset.copied = String(ok);
        window.setTimeout(() => {
          text.textContent = "Copy";
          delete copy.dataset.copied;
        }, 1600);
      });
      return;
    }
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = el.closest("a");
    if (!a || a.target === "_blank") return;
    const parsed = parseDocsHref(a.getAttribute("href") ?? "", import.meta.env.BASE_URL);
    if (!parsed) return;
    e.preventDefault();
    void navigate({ to: "/docs/$slug/", params: { slug: parsed.slug ?? slug }, hash: parsed.hash });
  };

  return (
    // Clicks are delegated: links inside the compiled HTML navigate without reloading the page.
    <div ref={ref} className="prose-docs" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
  );
}
