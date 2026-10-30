import type { ContentEntryMetaDto, ContentListKey } from "@mcsm/shared";

/** Test helper: a resolved meta with sensible defaults. */
export function meta(o: Partial<ContentEntryMetaDto> & { raw: string }): ContentEntryMetaDto {
  const [projectId, versionId] = o.raw.includes(":") ? o.raw.split(":") : [o.raw, null];
  return {
    list: "mods.modrinthProjects" as ContentListKey, resolved: true, projectId: projectId ?? null, versionId: versionId ?? null,
    slug: null, name: null, author: null, iconUrl: null, versionLabel: null, versionType: "release",
    gameVersions: ["1.21.1"], loaders: ["fabric"], dependencies: [], ...o,
  };
}

export const req = (projectId: string) => ({ projectId, versionId: null, type: "required" as const });
