import type { TemplateSpec } from "@mcsm/shared";
import type { Db } from "../db/db.js";
import { newId } from "../lib/ids.js";
import { nowIso } from "../lib/time.js";

export interface TemplateRow {
  id: string; name: string; description: string; spec: string; source_server_id: string | null;
  created_at: string; updated_at: string;
}

export interface TemplateDto {
  id: string; name: string; description: string; spec: TemplateSpec; sourceServerId: string | null;
  createdAt: string; updatedAt: string;
}

export function toTemplateDto(r: TemplateRow): TemplateDto {
  return {
    id: r.id, name: r.name, description: r.description, spec: JSON.parse(r.spec) as TemplateSpec,
    sourceServerId: r.source_server_id, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export class TemplatesRepo {
  constructor(private db: Db) {}

  list(): TemplateRow[] {
    return this.db.prepare("SELECT * FROM templates ORDER BY name COLLATE NOCASE").all() as unknown as TemplateRow[];
  }
  get(id: string): TemplateRow | null {
    return (this.db.prepare("SELECT * FROM templates WHERE id = ?").get(id) as TemplateRow | undefined) ?? null;
  }
  getByName(name: string): TemplateRow | null {
    return (this.db.prepare("SELECT * FROM templates WHERE name = ?").get(name) as TemplateRow | undefined) ?? null;
  }
  create(input: { name: string; description: string; spec: TemplateSpec; sourceServerId: string | null }): TemplateRow {
    const id = newId();
    const now = nowIso();
    this.db.prepare(`INSERT INTO templates (id, name, description, spec, source_server_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, input.name, input.description, JSON.stringify(input.spec), input.sourceServerId, now, now);
    return this.get(id)!;
  }
  update(id: string, input: { name: string; description: string; spec: TemplateSpec }): TemplateRow {
    this.db.prepare("UPDATE templates SET name = ?, description = ?, spec = ?, updated_at = ? WHERE id = ?")
      .run(input.name, input.description, JSON.stringify(input.spec), nowIso(), id);
    return this.get(id)!;
  }
  delete(id: string): boolean {
    return this.db.prepare("DELETE FROM templates WHERE id = ?").run(id).changes === 1;
  }
}

declare module "fastify" {
  interface FastifyInstance { templates: TemplatesRepo }
}
