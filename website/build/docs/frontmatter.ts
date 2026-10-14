import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const SECTIONS = ["Getting started", "Guides", "Operations", "Project"] as const;
export type Section = (typeof SECTIONS)[number];

export interface DocMeta {
  title: string;
  description: string;
  section: Section;
  order: number;
}

const metaSchema = z
  .object({
    title: z.string().trim().min(1),
    description: z.string().trim().min(1),
    section: z.enum(SECTIONS),
    order: z.number().int().nonnegative(),
  })
  .strict();

const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** Splits YAML frontmatter from the body and validates it with zod. Errors name `file`. */
export function parseDoc(source: string, file: string): { meta: DocMeta; body: string } {
  const text = source.replace(/^﻿/, "");
  const match = FRONTMATTER.exec(text);
  if (!match) {
    throw new Error(`${file}: missing frontmatter (a "---" block with title, description, section and order at the top)`);
  }
  let data: unknown;
  try {
    data = parseYaml(match[1] ?? "");
  } catch (err) {
    throw new Error(`${file}: invalid frontmatter YAML: ${err instanceof Error ? err.message : String(err)}`);
  }
  const result = metaSchema.safeParse(data ?? {});
  if (!result.success) {
    const problems = result.error.issues
      .map((i) => `${i.path.join(".") || "frontmatter"}: ${i.message}`)
      .join("; ");
    throw new Error(`${file}: invalid frontmatter: ${problems} (sections: ${SECTIONS.join(", ")})`);
  }
  return { meta: result.data, body: text.slice(match[0].length) };
}
