import { MODRINTH_LOADERS, usesCurseForge } from "@mcsm/shared";
import { useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { JAVA_TAGS, SERVER_TYPES, typeKind } from "@/lib/spec-catalog";
import { typeChangeNotice, withType, withVersion, type EditableSpec } from "@/lib/spec-edit";
import { blurVersionAction, hasVersionList, specChanged } from "@/lib/versions";
import { Field, ListField, OptionalSelect, RequiredSelect, type ReportError } from "./fields";
import { CurseForgeKeyNotice } from "./curseforge-key";
import { BuildPicker } from "./build-picker";
import { VersionPicker } from "./version-picker";

type Mods = NonNullable<EditableSpec["mods"]>;
type Plugins = NonNullable<EditableSpec["plugins"]>;
const EMPTY_MODS: Mods = { modrinthProjects: [], curseforgeFiles: [], urls: [] };
const EMPTY_PLUGINS: Plugins = { modrinthProjects: [], spigetResources: [], urls: [] };

const MODPACK_HELP: Record<string, { slug: string; slugHint: string; version: string; versionHint: string }> = {
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

const JAVA_HINT = "java25 for 26.x; java21 for 1.20.5–1.21.x; java17 for 1.17–1.20.4; java8 for older ones. It adjusts itself when the version changes.";

/** "Version and mods" section: type, version, Java, modpack, mods and plugins. */
export function VersionSection({ spec, onChange, onError }: { spec: EditableSpec; onChange: (s: EditableSpec) => void; onError?: ReportError }) {
  const [notice, setNotice] = useState<string | null>(null);
  const [javaNotice, setJavaNotice] = useState<string | null>(null);
  // Choosing a version clears the build and adjusts Java (withVersion); typed by hand, it does so on leaving the field.
  const setVersion = (v: string) => {
    const r = withVersion(spec, v);
    setJavaNotice(r.notice);
    if (specChanged(spec, r.spec)) onChange(r.spec);
  };
  const versionAtFocus = useRef(spec.version);
  const kind = typeKind(spec.type);
  const mods = spec.mods ?? EMPTY_MODS;
  const plugins = spec.plugins ?? EMPTY_PLUGINS;
  // Visibility depends on the section EXISTING, not on it having items: otherwise, when deleting the last one
  // the fieldset would unmount while typing (losing focus and text).
  const hasMods = spec.mods !== undefined;
  const hasPlugins = spec.plugins !== undefined;
  const showMods = kind === "mods" || kind === "modpack" || kind === "other" || hasMods;
  const showPlugins = kind === "plugins" || kind === "other" || hasPlugins;
  const mp = spec.modpack;
  const help = mp ? MODPACK_HELP[mp.platform] : undefined;
  // The section is kept even when empty: that way the agent emits an empty MODRINTH_PROJECTS and itzg
  // deletes what it installed (removing the last mod removes it from the server).
  const setMods = (m: Partial<Mods>) => onChange({ ...spec, mods: { ...mods, ...m } });
  const setPlugins = (p: Partial<Plugins>) => onChange({ ...spec, plugins: { ...plugins, ...p } });

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field id="sf-type" label="Type">
          <RequiredSelect id="sf-type" value={spec.type} options={SERVER_TYPES} onChange={(t) => { setNotice(typeChangeNotice(spec, t)); setJavaNotice(null); onChange(withType(spec, t)); }} />
          {notice && <p role="status" className="text-xs text-amber-400">{notice}</p>}
        </Field>
        {hasVersionList(spec.type) ? (
          <Field id="sf-version" label="Minecraft version" hint="Choose from the list or type a version.">
            <VersionPicker id="sf-version" type={spec.type} value={spec.version} onChange={setVersion} />
          </Field>
        ) : (
          <Field id="sf-version" label="Minecraft version" hint="LATEST, SNAPSHOT or a version like 1.21.4.">
            <Input id="sf-version" value={spec.version} onChange={(e) => onChange({ ...spec, version: e.target.value })}
              onFocus={() => { versionAtFocus.current = spec.version; }}
              onBlur={(e) => {
                const action = blurVersionAction(versionAtFocus.current, e.target.value);
                if (action === "apply") setVersion(e.target.value.trim());
                else if (action === "trim") onChange({ ...spec, version: e.target.value.trim() });
              }} />
          </Field>
        )}
        <div className="flex flex-col gap-1.5">
          <Field id="sf-java" label="Java (image tag)" hint={JAVA_HINT}>
            <RequiredSelect id="sf-java" value={spec.imageTag} options={JAVA_TAGS.map((t) => ({ value: t, label: t }))}
              onChange={(t) => { setJavaNotice(null); onChange({ ...spec, imageTag: t }); }} />
          </Field>
          {javaNotice && <p role="status" className="text-xs text-amber-400">{javaNotice}</p>}
        </div>
        {/* `build` is missing in old specs: it is read as empty. */}
        <BuildPicker type={spec.type} version={spec.version} value={spec.build ?? ""} onChange={(build) => { if ((spec.build ?? "") !== build) onChange({ ...spec, build }); }} />
      </div>
      {spec.type === "SPIGOT" && (
        <p className="text-xs text-amber-400">itzg no longer downloads Spigot automatically: add BUILD_FROM_SOURCE=true to the environment variables (Advanced) or use Paper.</p>
      )}

      {mp && help && (
        <fieldset className="grid grid-cols-1 gap-3 rounded-md border border-border p-3 sm:grid-cols-3">
          <legend className="px-1 text-sm font-medium">Modpack</legend>
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
        </fieldset>
      )}

      {showMods && (
        <fieldset className="grid grid-cols-1 gap-3 rounded-md border border-border p-3 sm:grid-cols-3">
          <legend className="px-1 text-sm font-medium">Mods</legend>
          <ListField onError={onError} id="sf-mods-modrinth" label="Modrinth mods (MODRINTH_PROJECTS)" value={mods.modrinthProjects} placeholder={"lithium\nferritecore:beta"}
            hint="Slug or id per line; “:beta” or “:version” to pin." onChange={(l) => setMods({ modrinthProjects: l })} />
          <ListField onError={onError} id="sf-mods-cf" label="CurseForge (CURSEFORGE_FILES)" value={mods.curseforgeFiles} placeholder={"jei\njei:4593548"}
            hint="Slug, id, slug:file or URL per line." onChange={(l) => setMods({ curseforgeFiles: l })} />
          <ListField kind="url" onError={onError} id="sf-mods-urls" label=".jar URLs (MODS)" value={mods.urls} placeholder="https://…/mod.jar"
            hint="One http(s) URL per line. Removing a URL does not delete the .jar already downloaded." onChange={(l) => setMods({ urls: l })} />
        </fieldset>
      )}

      {showPlugins && (
        <fieldset className="grid grid-cols-1 gap-3 rounded-md border border-border p-3 sm:grid-cols-3">
          <legend className="px-1 text-sm font-medium">Plugins</legend>
          <ListField onError={onError} id="sf-pl-modrinth" label="Modrinth plugins (MODRINTH_PROJECTS)" value={plugins.modrinthProjects} placeholder={"luckperms\nchunky"}
            hint="Slug or id per line." onChange={(l) => setPlugins({ modrinthProjects: l })} />
          <ListField kind="digits" onError={onError} id="sf-pl-spiget" label="Spiget (SPIGET_RESOURCES)" value={plugins.spigetResources} placeholder={"28140\n34315"}
            hint="SpigotMC numeric id per line. Some (e.g. EssentialsX) do not allow automatic download." onChange={(l) => setPlugins({ spigetResources: l })} />
          <ListField kind="url" onError={onError} id="sf-pl-urls" label=".jar URLs (PLUGINS)" value={plugins.urls} placeholder="https://…/plugin.jar"
            hint="One http(s) URL per line. Removing a URL does not delete the .jar already downloaded." onChange={(l) => setPlugins({ urls: l })} />
        </fieldset>
      )}

      {kind === "vanilla" && !hasMods && !hasPlugins && (
        <p className="text-xs text-muted-foreground">Vanilla does not load mods or plugins. Choose Fabric/Forge/NeoForge/Quilt for mods or Paper/Purpur/Spigot for plugins.</p>
      )}
      {usesCurseForge(spec) && <CurseForgeKeyNotice />}
    </div>
  );
}
