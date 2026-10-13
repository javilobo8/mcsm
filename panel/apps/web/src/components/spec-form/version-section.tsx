import { MODRINTH_LOADERS, usesCurseForge } from "@mcsm/shared";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { JAVA_TAGS, SERVER_TYPES, typeKind } from "@/lib/spec-catalog";
import { typeChangeNotice, withType, withVersion, type EditableSpec } from "@/lib/spec-edit";
import { hasVersionList } from "@/lib/versions";
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
    slug: "Modpack de Modrinth", slugHint: "Slug, id o URL de modrinth.com (MODRINTH_MODPACK).",
    version: "Versión del modpack (opcional)", versionHint: "Id o número de versión (MODRINTH_VERSION). Vacío = la última compatible con la versión de Minecraft.",
  },
  AUTO_CURSEFORGE: {
    slug: "Modpack de CurseForge", slugHint: "Slug (CF_SLUG) o URL de la página o de un fichero (CF_PAGE_URL).",
    version: "Id del fichero (opcional)", versionHint: "Número de fichero para fijar versión (CF_FILE_ID). Vacío = el último.",
  },
  FTBA: {
    slug: "Id del modpack de FTB", slugHint: "Número del modpack (FTB_MODPACK_ID).",
    version: "Id de versión (opcional)", versionHint: "Número de versión (FTB_MODPACK_VERSION_ID). Vacío = la última.",
  },
};

const JAVA_HINT = "java25 para 26.x; java21 para 1.20.5–1.21.x; java17 para 1.17–1.20.4; java8 para anteriores. Se ajusta sola al cambiar la versión.";

/** Sección "Versión y mods": tipo, versión, Java, modpack, mods y plugins. */
export function VersionSection({ spec, onChange, onError }: { spec: EditableSpec; onChange: (s: EditableSpec) => void; onError?: ReportError }) {
  const [notice, setNotice] = useState<string | null>(null);
  const [javaNotice, setJavaNotice] = useState<string | null>(null);
  // Elegir versión vacía el build y ajusta la Java (withVersion); escrita a mano, al salir del campo.
  const setVersion = (v: string) => {
    const r = withVersion(spec, v);
    setJavaNotice(r.notice);
    if (r.spec.version !== spec.version || r.spec.imageTag !== spec.imageTag || r.spec.build !== spec.build) onChange(r.spec);
  };
  const kind = typeKind(spec.type);
  const mods = spec.mods ?? EMPTY_MODS;
  const plugins = spec.plugins ?? EMPTY_PLUGINS;
  // La visibilidad depende de que la sección EXISTA, no de que tenga ítems: si no, al borrar el último
  // el fieldset se desmontaría mientras se escribe (pérdida de foco y de texto).
  const hasMods = spec.mods !== undefined;
  const hasPlugins = spec.plugins !== undefined;
  const showMods = kind === "mods" || kind === "modpack" || kind === "other" || hasMods;
  const showPlugins = kind === "plugins" || kind === "other" || hasPlugins;
  const mp = spec.modpack;
  const help = mp ? MODPACK_HELP[mp.platform] : undefined;
  // La sección se conserva aunque quede vacía: así el agente emite MODRINTH_PROJECTS vacía e itzg
  // borra lo que instaló (quitar el último mod lo quita del servidor).
  const setMods = (m: Partial<Mods>) => onChange({ ...spec, mods: { ...mods, ...m } });
  const setPlugins = (p: Partial<Plugins>) => onChange({ ...spec, plugins: { ...plugins, ...p } });

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field id="sf-type" label="Tipo">
          <RequiredSelect id="sf-type" value={spec.type} options={SERVER_TYPES} onChange={(t) => { setNotice(typeChangeNotice(spec, t)); setJavaNotice(null); onChange(withType(spec, t)); }} />
          {notice && <p role="status" className="text-xs text-amber-400">{notice}</p>}
        </Field>
        {hasVersionList(spec.type) ? (
          <Field id="sf-version" label="Versión de Minecraft" hint="Elige de la lista o escribe una versión.">
            <VersionPicker id="sf-version" type={spec.type} value={spec.version} onChange={setVersion} />
          </Field>
        ) : (
          <Field id="sf-version" label="Versión de Minecraft" hint="LATEST, SNAPSHOT o una versión como 1.21.4.">
            <Input id="sf-version" value={spec.version} onChange={(e) => onChange({ ...spec, version: e.target.value })}
              onBlur={(e) => setVersion(e.target.value.trim())} />
          </Field>
        )}
        <div className="flex flex-col gap-1.5">
          <Field id="sf-java" label="Java (etiqueta de la imagen)" hint={JAVA_HINT}>
            <RequiredSelect id="sf-java" value={spec.imageTag} options={JAVA_TAGS.map((t) => ({ value: t, label: t }))}
              onChange={(t) => { setJavaNotice(null); onChange({ ...spec, imageTag: t }); }} />
          </Field>
          {javaNotice && <p role="status" className="text-xs text-amber-400">{javaNotice}</p>}
        </div>
        {/* `build` falta en specs antiguas: se lee como vacío. */}
        <BuildPicker type={spec.type} version={spec.version} value={spec.build ?? ""} onChange={(build) => onChange({ ...spec, build })} />
      </div>
      {spec.type === "SPIGOT" && (
        <p className="text-xs text-amber-400">itzg ya no descarga Spigot automáticamente: añade BUILD_FROM_SOURCE=true en las variables de entorno (Avanzado) o usa Paper.</p>
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
            <Field id="sf-mp-loader" label="Loader (opcional)" hint="Solo si el modpack publica versiones para varios loaders.">
              <OptionalSelect id="sf-mp-loader" value={mp.loader || undefined}
                options={MODRINTH_LOADERS.filter((l) => l !== "").map((l) => ({ value: l, label: l }))}
                onChange={(l) => onChange({ ...spec, modpack: { ...mp, loader: (l ?? "") as typeof mp.loader } })} defaultLabel="(cualquiera)" />
            </Field>
          )}
        </fieldset>
      )}

      {showMods && (
        <fieldset className="grid grid-cols-1 gap-3 rounded-md border border-border p-3 sm:grid-cols-3">
          <legend className="px-1 text-sm font-medium">Mods</legend>
          <ListField onError={onError} id="sf-mods-modrinth" label="Mods de Modrinth (MODRINTH_PROJECTS)" value={mods.modrinthProjects} placeholder={"lithium\nferritecore:beta"}
            hint="Slug o id por línea; «:beta» o «:versión» para fijar." onChange={(l) => setMods({ modrinthProjects: l })} />
          <ListField onError={onError} id="sf-mods-cf" label="CurseForge (CURSEFORGE_FILES)" value={mods.curseforgeFiles} placeholder={"jei\njei:4593548"}
            hint="Slug, id, slug:fichero o URL por línea." onChange={(l) => setMods({ curseforgeFiles: l })} />
          <ListField kind="url" onError={onError} id="sf-mods-urls" label="URLs de .jar (MODS)" value={mods.urls} placeholder="https://…/mod.jar"
            hint="Una URL http(s) por línea. Quitar una URL no borra el .jar ya descargado." onChange={(l) => setMods({ urls: l })} />
        </fieldset>
      )}

      {showPlugins && (
        <fieldset className="grid grid-cols-1 gap-3 rounded-md border border-border p-3 sm:grid-cols-3">
          <legend className="px-1 text-sm font-medium">Plugins</legend>
          <ListField onError={onError} id="sf-pl-modrinth" label="Plugins de Modrinth (MODRINTH_PROJECTS)" value={plugins.modrinthProjects} placeholder={"luckperms\nchunky"}
            hint="Slug o id por línea." onChange={(l) => setPlugins({ modrinthProjects: l })} />
          <ListField kind="digits" onError={onError} id="sf-pl-spiget" label="Spiget (SPIGET_RESOURCES)" value={plugins.spigetResources} placeholder={"28140\n34315"}
            hint="Id numérico de SpigotMC por línea. Algunos (p. ej. EssentialsX) no permiten descarga automática." onChange={(l) => setPlugins({ spigetResources: l })} />
          <ListField kind="url" onError={onError} id="sf-pl-urls" label="URLs de .jar (PLUGINS)" value={plugins.urls} placeholder="https://…/plugin.jar"
            hint="Una URL http(s) por línea. Quitar una URL no borra el .jar ya descargado." onChange={(l) => setPlugins({ urls: l })} />
        </fieldset>
      )}

      {kind === "vanilla" && !hasMods && !hasPlugins && (
        <p className="text-xs text-muted-foreground">Vanilla no carga mods ni plugins. Elige Fabric/Forge/NeoForge/Quilt para mods o Paper/Purpur/Spigot para plugins.</p>
      )}
      {usesCurseForge(spec) && <CurseForgeKeyNotice />}
    </div>
  );
}
