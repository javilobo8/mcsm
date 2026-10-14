import fs from "node:fs";
import path from "node:path";
import type { Element, ElementContent, Root as HastRoot } from "hast";
import type { Blockquote, Paragraph, Root as MdastRoot } from "mdast";
import { toString as hastToString } from "hast-util-to-string";
import rehypeSlug from "rehype-slug";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { createHighlighter, type Highlighter } from "shiki";
import { unified } from "unified";
import { SKIP, visit } from "unist-util-visit";

export interface TocEntry {
  depth: 2 | 3;
  id: string;
  text: string;
}

export interface CompileOptions {
  /** Ends with "/", e.g. "/mcsm/". */
  base: string;
  /** Absolute path of the repository root. */
  repoRoot: string;
  /** Default: fs.readFileSync(p, "utf8"). */
  readFile?: (absPath: string) => string;
  /** For error messages. */
  file?: string;
}

export interface CompiledDoc {
  html: string;
  /** h2 and h3 only, in order. */
  toc: TocEntry[];
  /** Every heading id (h2–h6). */
  headingIds: string[];
  /**
   * Internal links as written: "/docs/<slug>" or "/docs/<slug>#<anchor>". Links to an anchor of the
   * same page ("#<anchor>") and any other non-absolute link are recorded too, so the content test
   * can reject them (loadDocs turns "#<anchor>" into "/docs/<slug>#<anchor>").
   */
  links: string[];
  /** Image src as written: "/screenshots/<name>.webp". */
  images: string[];
}

const THEME = "github-dark-default";
/** Languages loaded into shiki (the docs use bash, yaml, ini/dotenv, json, ts, go and text). */
const LANGS = ["shellscript", "shellsession", "yaml", "ini", "dotenv", "json", "jsonc", "typescript", "javascript", "go", "dockerfile", "diff", "toml", "proto"];

let highlighter: Promise<Highlighter> | undefined;
function getHighlighter(): Promise<Highlighter> {
  highlighter ??= createHighlighter({ themes: [THEME], langs: LANGS });
  return highlighter;
}

const ALERTS = { note: "Note", tip: "Tip", important: "Important", warning: "Warning", caution: "Caution" } as const;
type AlertKind = keyof typeof ALERTS;
const ALERT_MARKER = /^\[!(note|tip|important|warning|caution)\][ \t]*(?:\r?\n|$)/i;

const INCLUDE_META = /(?:^|\s)include="([^"]*)"/;

/** Absolute path of an include, or an error if it is not a file under `<repoRoot>/deploy/`. */
function resolveInclude(p: string, repoRoot: string, file: string): string {
  const deployDir = path.resolve(repoRoot, "deploy");
  const abs = path.resolve(repoRoot, p);
  const rel = path.relative(deployDir, abs);
  const bad =
    p === "" ||
    path.isAbsolute(p) ||
    p.includes("\\") ||
    p.split("/").includes("..") ||
    rel === "" ||
    rel.startsWith("..") ||
    path.isAbsolute(rel);
  if (bad) throw new Error(`${file}: include "${p}" is not allowed: only relative paths under deploy/ (without "..")`);
  return abs;
}

function readInclude(p: string, opts: CompileOptions, file: string): string {
  const abs = resolveInclude(p, opts.repoRoot, file);
  try {
    if (fs.existsSync(abs)) {
      // A symbolic link must not lead outside deploy/ either.
      const real = fs.realpathSync(abs);
      const realDeploy = fs.realpathSync(path.resolve(opts.repoRoot, "deploy"));
      const rel = path.relative(realDeploy, real);
      if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
        throw new Error(`${file}: include "${p}" is not allowed: it resolves outside deploy/`);
      }
    }
    return (opts.readFile ?? ((f: string) => fs.readFileSync(f, "utf8")))(abs);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith(`${file}: include`)) throw err;
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") throw new Error(`${file}: include "${p}" not found`);
    throw new Error(`${file}: include "${p}" could not be read: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Markdown-level rules: no h1, includes, GitHub alerts → callouts. */
function remarkDocs(opts: CompileOptions, file: string) {
  return (tree: MdastRoot) => {
    visit(tree, (node) => {
      if (node.type === "heading" && node.depth === 1) {
        const line = node.position?.start.line;
        throw new Error(
          `${file}${line ? `:${line}` : ""}: level-1 heading ("# …") in the body; the page title comes from the frontmatter, start sections at "##"`,
        );
      }
      if (node.type === "code") {
        const include = INCLUDE_META.exec(node.meta ?? "")?.[1];
        if (include !== undefined) {
          if (node.value.trim() !== "") throw new Error(`${file}: a code block with include="${include}" must be empty`);
          node.value = readInclude(include, opts, file).replace(/\s+$/, "");
        }
      }
      if (node.type === "blockquote") convertAlert(node);
    });
  };
}

function convertAlert(node: Blockquote): void {
  const first = node.children[0];
  if (first?.type !== "paragraph") return;
  const text = first.children[0];
  if (text?.type !== "text") return;
  const match = ALERT_MARKER.exec(text.value);
  if (!match) return;
  const kind = match[1]!.toLowerCase() as AlertKind;
  text.value = text.value.slice(match[0].length);
  if (text.value === "") first.children.shift();
  if (first.children[0]?.type === "break") first.children.shift();
  if (first.children.length === 0) node.children.shift();
  const title: Paragraph = {
    type: "paragraph",
    data: { hProperties: { className: ["callout-title"] } },
    children: [{ type: "text", value: ALERTS[kind] }],
  };
  node.children.unshift(title);
  node.data = { ...node.data, hName: "div", hProperties: { className: ["callout", `callout-${kind}`] } };
}

interface Collected {
  toc: TocEntry[];
  headingIds: string[];
  links: string[];
  images: string[];
}

/** Rewrites a written "/docs/<slug>#<anchor>" into the deployed URL. */
function docsHref(href: string, base: string): string {
  const m = /^\/docs\/([^#/?]+)\/?(#.*)?$/.exec(href);
  if (!m) return `${base}${href.replace(/^\/+/, "")}`;
  return `${base}docs/${m[1]}/${m[2] ?? ""}`;
}

const isExternal = (url: string) => /^https?:\/\//i.test(url);
const isOtherScheme = (url: string) => /^[a-z][a-z0-9+.-]*:/i.test(url);

/** HTML-level rules: links, images, TOC, heading anchors and highlighted code blocks. */
function rehypeDocs(opts: CompileOptions, out: Collected) {
  return async (tree: HastRoot) => {
    visit(tree, "element", (el) => {
      if (el.tagName === "a" && typeof el.properties.href === "string") {
        const href = el.properties.href;
        if (isExternal(href)) {
          el.properties.target = "_blank";
          el.properties.rel = ["noopener", "noreferrer"];
        } else if (!isOtherScheme(href) && !href.startsWith("//")) {
          out.links.push(href);
          if (href.startsWith("/")) el.properties.href = docsHref(href, opts.base);
        }
      }
      if (el.tagName === "img" && typeof el.properties.src === "string") {
        const src = el.properties.src;
        if (!isExternal(src) && !isOtherScheme(src) && !src.startsWith("//")) {
          out.images.push(src);
          if (src.startsWith("/")) el.properties.src = `${opts.base}${src.replace(/^\/+/, "")}`;
        }
        el.properties.loading = "lazy";
        el.properties.decoding = "async";
      }
    });

    visit(tree, "element", (el) => {
      const depth = /^h([2-6])$/.exec(el.tagName)?.[1];
      if (!depth || typeof el.properties.id !== "string") return;
      const id = el.properties.id;
      out.headingIds.push(id);
      if (depth === "2" || depth === "3") {
        const text = hastToString(el).trim();
        out.toc.push({ depth: depth === "2" ? 2 : 3, id, text });
        el.children.push({
          type: "element",
          tagName: "a",
          properties: { href: `#${id}`, className: ["heading-anchor"], ariaLabel: `Link to “${text}”` },
          children: [{ type: "text", value: "#" }],
        });
      }
      return SKIP;
    });

    // Wide tables scroll inside their own box instead of the page.
    visit(tree, "element", (el, index, parent) => {
      if (el.tagName !== "table" || index === undefined || !parent) return;
      parent.children[index] = { type: "element", tagName: "div", properties: { className: ["table-wrap"] }, children: [el] };
      return SKIP;
    });

    const blocks: { parent: HastRoot | Element; index: number; pre: Element }[] = [];
    visit(tree, "element", (el, index, parent) => {
      if (el.tagName !== "pre" || index === undefined || !parent) return;
      blocks.push({ parent, index, pre: el });
      return SKIP;
    });
    if (blocks.length === 0) return;

    const hl = await getHighlighter();
    const loaded = new Set(hl.getLoadedLanguages());
    for (const { parent, index, pre } of blocks) {
      const code = pre.children.find((c): c is Element => c.type === "element" && c.tagName === "code");
      const classes = code?.properties.className;
      const langClass = Array.isArray(classes) ? classes.find((c) => typeof c === "string" && c.startsWith("language-")) : undefined;
      const lang = typeof langClass === "string" ? langClass.slice("language-".length).toLowerCase() : "text";
      const source = (code ? hastToString(code) : hastToString(pre)).replace(/\n$/, "");
      const highlighted = hl.codeToHast(source, { lang: loaded.has(lang) ? lang : "text", theme: THEME });
      const shikiPre = highlighted.children.find((c): c is Element => c.type === "element" && c.tagName === "pre");
      if (!shikiPre) continue;
      delete shikiPre.properties.style;
      const meta = (code?.data as { meta?: string } | undefined)?.meta;
      const include = meta ? INCLUDE_META.exec(meta)?.[1] : undefined;
      const wrapper: ElementContent = {
        type: "element",
        tagName: "div",
        properties: { className: ["code-block"], dataLang: lang, ...(include ? { dataFile: include } : {}) },
        children: [shikiPre],
      };
      parent.children[index] = wrapper;
    }
  };
}

export async function compileDoc(body: string, opts: CompileOptions): Promise<CompiledDoc> {
  const file = opts.file ?? "document";
  const out: Collected = { toc: [], headingIds: [], links: [], images: [] };
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(() => remarkDocs(opts, file))
    .use(remarkRehype, { allowDangerousHtml: false })
    .use(rehypeSlug)
    .use(() => rehypeDocs(opts, out))
    .use(rehypeStringify);
  const html = String(await processor.process(body));
  return { html, ...out };
}
