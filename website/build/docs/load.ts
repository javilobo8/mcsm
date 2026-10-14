import fs from "node:fs";
import path from "node:path";
import { sortPages } from "../../src/lib/docs-nav.ts";
import { compileDoc, type CompiledDoc, type CompileOptions } from "./compile.ts";
import { parseDoc, type DocMeta } from "./frontmatter.ts";

export interface LoadedDoc extends DocMeta, CompiledDoc {
  slug: string;
}

const SLUG = /^[a-z0-9][a-z0-9-]*$/;

/** Reads every *.md in `dir` (missing dir → []), parses, compiles, sorts with sortPages. */
export async function loadDocs(dir: string, opts: Omit<CompileOptions, "file">): Promise<LoadedDoc[]> {
  if (!fs.existsSync(dir)) return [];
  const files = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => e.name)
    .sort();
  const docs: LoadedDoc[] = [];
  for (const name of files) {
    const slug = name.slice(0, -".md".length);
    if (!SLUG.test(slug)) throw new Error(`${name}: the file name must be a slug (lowercase letters, digits and "-")`);
    const { meta, body } = parseDoc(fs.readFileSync(path.join(dir, name), "utf8"), name);
    const compiled = await compileDoc(body, { ...opts, file: name });
    // A link to an anchor of the same page is checked like any other internal link.
    const links = compiled.links.map((l) => (l.startsWith("#") ? `/docs/${slug}${l}` : l));
    docs.push({ slug, ...meta, ...compiled, links });
  }
  return sortPages(docs);
}
