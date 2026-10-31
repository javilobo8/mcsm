import { usesCurseForge } from "@mcsm/shared";
import { useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { JAVA_TAGS, SERVER_TYPES, typeKind } from "@/lib/spec-catalog";
import { typeChangeNotice, withType, withVersion, type EditableSpec } from "@/lib/spec-edit";
import { blurVersionAction, hasVersionList, specChanged } from "@/lib/versions";
import { browseTarget } from "@/lib/content-target";
import { useInstalledPack } from "@/hooks/use-content";
import { ContentSection, ContentTextFields } from "@/components/content/content-section";
import { Field, RequiredSelect, type ReportError } from "./fields";
import { MODPACK_HELP, ModpackFields } from "./modpack-fields";
import { PackCard } from "@/components/content/pack-card";
import { CurseForgeKeyNotice } from "./curseforge-key";
import { BuildPicker } from "./build-picker";
import { VersionPicker } from "./version-picker";

const JAVA_HINT = "java25 for 26.x; java21 for 1.20.5–1.21.x; java17 for 1.17–1.20.4; java8 for older ones. It adjusts itself when the version changes.";

/**
 * "Version and mods" section: type, version, Java, modpack, mods, plugins and datapacks. `contentUi`: "browser" turns the
 * content lists into installed lists with the content browser (Configuration, new server); "text" keeps the textareas
 * (template editor).
 */
export function VersionSection({ spec, onChange, onError, contentUi = "text" }: {
  spec: EditableSpec; onChange: (s: EditableSpec) => void; onError?: ReportError; contentUi?: "text" | "browser";
}) {
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
  // Visibility depends on the section EXISTING, not on it having items: otherwise, when deleting the last one
  // the fieldset would unmount while typing (losing focus and text).
  const hasMods = spec.mods !== undefined;
  const hasPlugins = spec.plugins !== undefined;
  const showMods = kind === "mods" || kind === "modpack" || kind === "other" || hasMods;
  const showPlugins = kind === "plugins" || kind === "other" || hasPlugins;
  const mp = spec.modpack;
  const help = mp ? MODPACK_HELP[mp.platform] : undefined;
  // Sections are kept even when empty: that way the agent emits an empty MODRINTH_PROJECTS and itzg
  // deletes what it installed (removing the last mod removes it from the server).

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field id="sf-type" label="Type">
          <RequiredSelect id="sf-type" value={spec.type} options={SERVER_TYPES} onChange={(t) => { setNotice(typeChangeNotice(spec, t)); setJavaNotice(null); onChange(withType(spec, t)); }} />
          {notice && <p role="status" className="text-xs text-warn">{notice}</p>}
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
          {javaNotice && <p role="status" className="text-xs text-warn">{javaNotice}</p>}
        </div>
        {/* `build` is missing in old specs: it is read as empty. */}
        <BuildPicker type={spec.type} version={spec.version} value={spec.build ?? ""} onChange={(build) => { if ((spec.build ?? "") !== build) onChange({ ...spec, build }); }} />
      </div>
      {spec.type === "SPIGOT" && (
        <p className="text-xs text-warn">itzg no longer downloads Spigot automatically: add BUILD_FROM_SOURCE=true to the environment variables (Advanced) or use Paper.</p>
      )}

      {/* Browser mode: Modrinth and CurseForge packs get the pack card (in BrowserContent); FTB keeps the manual fields. */}
      {mp && help && (contentUi === "text" || mp.platform === "FTBA") && (
        <fieldset className="grid grid-cols-1 gap-3 rounded-md border border-border p-3 sm:grid-cols-3">
          <legend className="px-1 text-sm font-medium">Modpack</legend>
          <ModpackFields spec={spec} onChange={onChange} />
        </fieldset>
      )}

      {contentUi === "browser" ? (
        <BrowserContent spec={spec} onChange={onChange} onError={onError} showMods={showMods} showPlugins={showPlugins} />
      ) : (
        <>
          {showMods && (
            <fieldset className="rounded-md border border-border p-3">
              <legend className="px-1 text-sm font-medium">Mods</legend>
              <ContentTextFields spec={spec} onChange={onChange} onError={onError} section="mods" allOptional={false} />
            </fieldset>
          )}
          {showPlugins && (
            <fieldset className="rounded-md border border-border p-3">
              <legend className="px-1 text-sm font-medium">Plugins</legend>
              <ContentTextFields spec={spec} onChange={onChange} onError={onError} section="plugins" allOptional={false} />
            </fieldset>
          )}
          {spec.datapacks !== undefined && (
            <fieldset className="rounded-md border border-border p-3">
              <legend className="px-1 text-sm font-medium">Datapacks</legend>
              <ContentTextFields spec={spec} onChange={onChange} onError={onError} section="datapacks" allOptional={false} />
            </fieldset>
          )}
        </>
      )}

      {kind === "vanilla" && !hasMods && !hasPlugins && (
        <p className="text-xs text-muted-foreground">Vanilla does not load mods or plugins. Choose Fabric/Forge/NeoForge/Quilt for mods or Paper/Purpur/Spigot for plugins.</p>
      )}
      {usesCurseForge(spec) && <CurseForgeKeyNotice />}
    </div>
  );
}

/** Browser mode: installed lists per kind; datapacks on every type (every type loads them). */
function BrowserContent({ spec, onChange, onError, showMods, showPlugins }: {
  spec: EditableSpec; onChange: (s: EditableSpec) => void; onError?: ReportError; showMods: boolean; showPlugins: boolean;
}) {
  const installed = useInstalledPack(spec.modpack);
  const pack = installed.info.data ?? null;
  const target = (k: "mod" | "plugin" | "datapack") => { const t = browseTarget(spec, k, pack); return t.ok ? t.target : null; };
  const common = { spec, onChange, onError, pack, packError: installed.error };
  return (
    <>
      {spec.modpack && spec.modpack.platform !== "FTBA" && <PackCard spec={spec} onChange={onChange} />}
      {showMods && <ContentSection {...common} lists={["mods.modrinthProjects", "mods.curseforgeFiles"]} title="Mods" kind="mod" target={target("mod")} />}
      {showPlugins && <ContentSection {...common} lists={["plugins.modrinthProjects", "plugins.curseforgeFiles"]} title="Plugins" kind="plugin" target={target("plugin")} />}
      <ContentSection {...common} lists={["datapacks.modrinthProjects"]} title="Datapacks" kind="datapack" target={target("datapack")} />
    </>
  );
}
