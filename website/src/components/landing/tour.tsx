import { Tabs } from "radix-ui";
import { useMediaQuery } from "@/hooks/use-media-query";
import { BrowserFrame, screenshot } from "./browser-frame";
import { Section, SectionHeading } from "./section";

// Real screenshots from the end-to-end run of the panel (panel/apps/e2e), one line each.
const STOPS = [
  { id: "dashboard", label: "Dashboard", shot: "11-dashboard-node-cards", caption: "Every node with its CPU, RAM and disk, and every server with its status, players, version, node and the address players join." },
  { id: "new-server", label: "New server", shot: "01b-selector-version", caption: "A three-step wizard: a template or a server from scratch (type, a version from the official lists, memory), then the node and name, then a review." },
  { id: "overview", label: "Overview", shot: "03-overview-charts", height: 914, caption: "Players, detected version, uptime, latency and health, with charts for the last hour, day or week." },
  { id: "console", label: "Console", shot: "04-console", caption: "The live log with a filter, and commands sent over RCON with history." },
  { id: "configuration", label: "Configuration", shot: "05-configuration", caption: "Version and mods, properties, players, network, resources and advanced settings, reviewed before they are applied." },
  { id: "backups", label: "Backups", shot: "06-backups", caption: "Backups on demand or on a schedule, with retention and exclusions, and restore with the current data set aside." },
  { id: "files", label: "Files", shot: "07-files", caption: "The server's data folder: browse it, edit text files, upload and download." },
  { id: "migrate", label: "Migrate", shot: "09-migrate", caption: "Pick the target node and its game port; the world, configuration and history move with the server." },
  { id: "add-node", label: "Add a node", shot: "12b-add-node-command", caption: "One docker run for each new machine, with a token that works once and expires after 15 minutes." },
  { id: "jobs", label: "Jobs", shot: "17-jobs", caption: "Backups, restores and migrations run as jobs, with their status, progress and log." },
] as const;

export function Tour() {
  const wide = useMediaQuery("(min-width: 1024px)");
  return (
    <Section id="tour" className="pt-24 sm:pt-32">
      <SectionHeading id="tour" title="See it before you install it">
        Screenshots of the real panel, taken by its end-to-end tests against two nodes.
      </SectionHeading>

      <Tabs.Root defaultValue="dashboard" orientation={wide ? "vertical" : "horizontal"} className="mt-10 lg:grid lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-8">
        <Tabs.List
          aria-label="Screens of the panel"
          className="-mx-4 flex gap-1 overflow-x-auto px-4 pb-3 [scrollbar-width:none] sm:-mx-6 sm:px-6 lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0 lg:pb-0"
        >
          {STOPS.map((s) => (
            <Tabs.Trigger
              key={s.id}
              value={s.id}
              className="shrink-0 rounded-md border border-transparent px-3 py-2 text-left text-sm whitespace-nowrap text-fog transition-colors hover:text-bone data-[state=active]:border-cobble data-[state=active]:bg-bedrock data-[state=active]:text-bone lg:flex lg:items-center lg:gap-2.5"
            >
              <span aria-hidden="true" className="hidden size-2 bg-cobble-2 transition-colors lg:inline-block [[data-state=active]>&]:bg-grass" />
              {s.label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        {STOPS.map((s) => (
          <Tabs.Content key={s.id} value={s.id} className="mt-2 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-torch lg:mt-0">
            <BrowserFrame src={screenshot(s.shot)} alt={`${s.label}: ${s.caption}`} height={"height" in s ? s.height : 900} />
            <p className="mt-4 max-w-[46rem] text-[0.9375rem] leading-relaxed text-fog">{s.caption}</p>
          </Tabs.Content>
        ))}
      </Tabs.Root>
    </Section>
  );
}
