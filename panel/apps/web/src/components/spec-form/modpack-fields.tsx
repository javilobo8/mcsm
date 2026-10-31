import { MODRINTH_LOADERS } from "@mcsm/shared";
import { Input } from "@/components/ui/input";
import type { EditableSpec } from "@/lib/spec-edit";
import { Field, OptionalSelect } from "./fields";

export const MODPACK_HELP: Record<string, { slug: string; slugHint: string; version: string; versionHint: string }> = {
  MODRINTH: {
    slug: "Modrinth modpack", slugHint: "Slug, id or URL from modrinth.com (MODRINTH_MODPACK).",
    version: "Modpack version (optional)", versionHint: "Version id or number (MODRINTH_VERSION). Empty = the latest compatible with the Minecraft version.",
  },
  AUTO_CURSEFORGE: {
    slug: "CurseForge modpack", slugHint: "Slug (CF_SLUG) or URL of the page or of a file (CF_PAGE_URL).",
    version: "File id (optional)", versionHint: "File number to pin the version (CF_FILE_ID). Empty = the latest.",
  },
  FTBA: {
    slug: "FTB modpack id", slugHint: "Modpack number (FTB_MODPACK_ID).",
    version: "Version id (optional)", versionHint: "Version number (FTB_MODPACK_VERSION_ID). Empty = the latest.",
  },
};

/** The modpack typed by hand (slug/id/URL, version, loader): the template editor, FTB packs and the pack card's "Edit as text". */
export function ModpackFields({ spec, onChange }: { spec: EditableSpec; onChange: (s: EditableSpec) => void }) {
  const mp = spec.modpack;
  const help = mp ? MODPACK_HELP[mp.platform] : undefined;
  if (!mp || !help) return null;
  return (
    <>
      <Field id="sf-mp-slug" label={help.slug} hint={help.slugHint}>
        <Input id="sf-mp-slug" value={mp.slugOrUrl} onChange={(e) => onChange({ ...spec, modpack: { ...mp, slugOrUrl: e.target.value } })}
          onBlur={(e) => { if (e.target.value !== e.target.value.trim()) onChange({ ...spec, modpack: { ...mp, slugOrUrl: e.target.value.trim() } }); }} />
      </Field>
      <Field id="sf-mp-version" label={help.version} hint={help.versionHint}>
        <Input id="sf-mp-version" value={mp.versionId} onChange={(e) => onChange({ ...spec, modpack: { ...mp, versionId: e.target.value } })}
          onBlur={(e) => { if (e.target.value !== e.target.value.trim()) onChange({ ...spec, modpack: { ...mp, versionId: e.target.value.trim() } }); }} />
      </Field>
      {mp.platform === "MODRINTH" && (
        <Field id="sf-mp-loader" label="Loader (optional)" hint="Only if the modpack publishes versions for several loaders.">
          <OptionalSelect id="sf-mp-loader" value={mp.loader || undefined}
            options={MODRINTH_LOADERS.filter((l) => l !== "").map((l) => ({ value: l, label: l }))}
            onChange={(l) => onChange({ ...spec, modpack: { ...mp, loader: (l ?? "") as typeof mp.loader } })} defaultLabel="(any)" />
        </Field>
      )}
    </>
  );
}
