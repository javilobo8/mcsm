import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Section, SectionHeading } from "./section";

// Every claim here comes from the README and the code (server types: VERSION_LIST_TYPES and
// MODPACK_PLATFORMS in panel/packages/shared; metrics retention: RETENTION_SECONDS).

function Cell({ title, children, art, className }: { title: string; children: ReactNode; art?: ReactNode; className?: string }) {
  return (
    <li className={cn("flex min-w-0 flex-col rounded-lg border border-cobble bg-bedrock/70 p-5 sm:p-6", className)}>
      <h3 className="text-[1.0625rem] font-semibold text-bone">{title}</h3>
      <p className="mt-2 text-[0.9375rem] leading-relaxed text-fog">{children}</p>
      {art && <div className="mt-5 flex flex-1 flex-col justify-end">{art}</div>}
    </li>
  );
}

const TYPES = ["Vanilla", "Paper", "Folia", "Purpur", "Spigot", "Fabric", "Quilt", "Forge", "NeoForge"];
const MODPACKS = ["Modrinth", "CurseForge", "FTB"];

function TypesArt() {
  return (
    <div aria-hidden="true" className="grid grid-cols-1 gap-5 sm:grid-cols-[minmax(0,1fr)_14rem]">
      <div className="space-y-2.5">
        <div className="flex flex-wrap gap-1.5">
          {TYPES.map((t) => (
            <span key={t} className="rounded-sm bg-grass/12 px-2 py-0.5 text-[0.8125rem] font-medium text-grass-bright">{t}</span>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[0.8125rem] text-fog">Modpacks from</span>
          {MODPACKS.map((t) => (
            <span key={t} className="rounded-sm bg-torch/12 px-2 py-0.5 text-[0.8125rem] font-medium text-torch">{t}</span>
          ))}
        </div>
      </div>
      {/* Like the version picker of the new-server wizard. */}
      <div className="overflow-hidden rounded-md border border-cobble bg-deepslate/60 text-[0.8125rem]">
        <div className="border-b border-cobble px-3 py-1.5 text-fog">Minecraft version</div>
        <div className="px-3 pt-1.5 pb-0.5 text-[0.6875rem] text-fog">Stable</div>
        <div className="mx-1.5 rounded-sm bg-accent px-1.5 py-1 text-bone">1.21.4</div>
        <div className="px-3 pt-1.5 pb-0.5 text-[0.6875rem] text-fog">Snapshots and pre-releases</div>
        <div className="px-3 py-1 text-fog">1.21.4-rc3</div>
        <div className="px-3 pt-0.5 pb-2 text-fog">1.21.4-rc2</div>
      </div>
    </div>
  );
}

// Lines from the console of the end-to-end run.
const LOG = [
  ["16:19:02", "Done (7.404s)! For help, type \"help\""],
  ["16:19:02", "RCON running on 0.0.0.0:25575"],
  ["16:19:04", "> list"],
  ["16:19:04", "There are 0 of a max of 20 players online:"],
] as const;

function ConsoleArt() {
  return (
    <div aria-hidden="true" className="overflow-hidden rounded-md border border-cobble bg-[#0b0d10] font-mono text-[0.75rem] leading-[1.65]">
      <div className="space-y-px px-3 py-2.5">
        {LOG.map(([t, line], i) => (
          <div key={i} className="truncate">
            <span className="text-fog/70">{t} </span>
            <span className={line.startsWith(">") ? "text-[#5fc8d6]" : line.startsWith("There") ? "text-grass-bright" : "text-[#d5dae0]"}>{line}</span>
          </div>
        ))}
      </div>
      <div className="border-t border-cobble px-3 py-2 text-fog">
        <span className="text-grass">❯</span> say hello<span className="ml-0.5 inline-block h-3 w-1.5 translate-y-0.5 bg-bone/80" />
      </div>
    </div>
  );
}

function MetricsArt() {
  // An illustrative week of CPU samples, drawn as pixel columns.
  const bars = [3, 4, 3, 5, 7, 6, 4, 3, 5, 8, 9, 7, 5, 4, 6, 7, 5, 4, 3, 5, 6, 8, 6, 4, 3, 5, 7, 6, 5, 4, 6, 8, 7, 5, 4, 6];
  return (
    <div aria-hidden="true" className="flex items-end gap-4">
      <div className="flex h-10 flex-1 items-end gap-[3px]">
        {bars.map((h, i) => (
          <span key={i} className="flex-1 bg-grass/70" style={{ height: `${h * 10}%` }} />
        ))}
      </div>
      <div className="flex shrink-0 gap-1 text-[0.75rem] text-fog">
        <span className="rounded-sm px-1.5 py-0.5">1 h</span>
        <span className="rounded-sm px-1.5 py-0.5">24 h</span>
        <span className="rounded-sm bg-cobble px-1.5 py-0.5 text-bone">7 days</span>
      </div>
    </div>
  );
}

function BackupsArt() {
  // Rows like the Backups tab of the panel (illustrative dates and sizes).
  const rows = [
    ["Today, 04:00", "Scheduled", "108.4 MiB"],
    ["Yesterday, 04:00", "Scheduled", "108.1 MiB"],
    ["Monday, 16:19", "Manual", "107.9 MiB"],
  ] as const;
  return (
    <div aria-hidden="true" className="overflow-hidden rounded-md border border-cobble bg-deepslate/60 text-[0.8125rem]">
      {rows.map(([when, kind, size]) => (
        <div key={when} className="flex items-center gap-3 border-b border-cobble px-3 py-2 last:border-b-0">
          <span className="min-w-0 flex-1 truncate text-bone">{when}</span>
          <span className={kind === "Manual" ? "rounded-sm bg-cobble px-1.5 text-[0.75rem] text-bone" : "rounded-sm bg-grass/12 px-1.5 text-[0.75rem] text-grass-bright"}>{kind}</span>
          <span className="w-[4.75rem] text-right text-fog tabular-nums">{size}</span>
        </div>
      ))}
      <div className="flex items-center justify-between gap-3 bg-bedrock/80 px-3 py-2 text-[0.75rem] text-fog">
        <span>Every day at 4:00, kept for 7 days</span>
        <span className="font-mono">0 4 * * *</span>
      </div>
    </div>
  );
}

function NodesArt() {
  // Illustrative nodes, like the cards of the dashboard.
  const nodes = [
    { name: "main", arch: "linux/amd64", cpu: 54 },
    { name: "raspberry-pi", arch: "linux/arm64", cpu: 23 },
    { name: "attic", arch: "linux/amd64", cpu: 8 },
  ];
  return (
    <div aria-hidden="true" className="space-y-2">
      {nodes.map((n) => (
        <div key={n.name} className="rounded-md border border-cobble bg-deepslate/60 px-3 py-2">
          <div className="flex items-baseline justify-between gap-2 text-[0.8125rem]">
            <span className="font-medium text-bone">{n.name}</span>
            <span className="text-[0.75rem] text-fog">{n.arch}</span>
          </div>
          {(["cpu"] as const).map((k) => (
            <div key={k} className="mt-1.5 flex items-center gap-2 text-[0.6875rem] text-fog">
              <span className="w-7 uppercase">{k}</span>
              <span className="h-1.5 flex-1 bg-cobble">
                <span className="block h-full bg-grass" style={{ width: `${n[k]}%` }} />
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function MigrateArt() {
  // The seven steps of a migration (README), caught at the sixth.
  return (
    <div aria-hidden="true">
      <div className="flex items-center gap-1.5">
        {Array.from({ length: 7 }, (_, i) => (
          <span key={i} className={cn("h-2 flex-1", i < 5 ? "bg-grass" : i === 5 ? "bg-torch" : "bg-cobble-2")} />
        ))}
      </div>
      <p className="mt-2.5 text-[0.8125rem] text-fog">
        <span className="text-bone">Step 6 of 7:</span> start it on the target and wait until it is healthy
      </p>
    </div>
  );
}

export function Features() {
  return (
    <Section id="features" className="pt-20 sm:pt-28">
      <SectionHeading id="features" title="Everything you used to do over SSH">
        Each server is an itzg/minecraft-server container. The panel creates it, configures it and looks after it on whichever machine it
        lives, and shows you what is going on.
      </SectionHeading>

      <ul className="mt-12 grid grid-cols-1 gap-4 md:grid-cols-6">
        <Cell title="Any server the itzg image runs" className="md:col-span-4" art={<TypesArt />}>
          Pick the type and a Minecraft version from the official lists, pin a build or loader, add mods and plugins from Modrinth,
          CurseForge, Spiget or a URL, or start from a modpack.
        </Cell>
        <Cell title="One agent per machine" className="md:col-span-2" art={<NodesArt />}>
          Add as many Docker machines as you have, amd64 or arm64, each with a small agent. Their CPU, RAM and disk are on the dashboard.
        </Cell>
        <Cell
          title="Live console and 7 days of metrics"
          className="md:col-span-3"
          art={
            <div className="space-y-4">
              <ConsoleArt />
              <MetricsArt />
            </div>
          }
        >
          Follow the log as it happens, filter it and send commands over RCON with history. Players, CPU and memory are charted for the
          last hour, day or week.
        </Cell>
        <Cell title="Hot and scheduled backups" className="md:col-span-3" art={<BackupsArt />}>
          Back up on demand or on a cron schedule, with retention by count and by age, and skip it when nobody has played. Hot backups
          pause saving while they copy. Restoring deletes nothing: the old data is set aside.
        </Cell>
        <Cell title="Move servers between machines" className="md:col-span-2" art={<MigrateArt />}>
          The world, configuration, backups and history go to another node in seven visible steps, checked with sha256. If anything
          fails before the end, the server stays where it was, world intact.
        </Cell>
        <Cell title="A file manager" className="md:col-span-2">
          Browse the data folder, edit text files and upload or download, streamed through the panel without touching its disk.
        </Cell>
        <Cell title="Adopt the servers you already have" className="md:col-span-2">
          Import finds the itzg/minecraft-server containers on a node that the panel doesn't manage yet. Adopting one stops nothing.
        </Cell>
        <Cell title="Join by hostname" className="md:col-span-2">
          Turn on <span className="text-bone">mc-router</span> for a node and players join <span className="font-mono text-[0.875rem] text-bone">survival.lan</span> or{" "}
          <span className="font-mono text-[0.875rem] text-bone">creative.lan</span> through one port. With autoscale, a sleeping server
          starts when someone joins.
        </Cell>
        <Cell title="Templates" className="md:col-span-2">
          Save a server as a template and create new ones from it, backup schedule included.
        </Cell>
        <Cell title="Crash-loop protection, events and jobs" className="md:col-span-2">
          More than three crashes in an hour and the server is stopped until you start it or save a new configuration. Events keep a
          record of what happened, and every job keeps its log.
        </Cell>
      </ul>
    </Section>
  );
}
