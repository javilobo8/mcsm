import { Link } from "@tanstack/react-router";
import { RAW_URL, VERSION } from "@/lib/site";
import { Snippet } from "./copy-button";
import { Section, SectionHeading } from "./section";

// The commands are the README's installation commands ("Main machine" and "Other machines").

const STEP_1 = `mkdir -p /opt/mcsm && cd /opt/mcsm
curl -fsSL -o docker-compose.yml ${RAW_URL}/deploy/docker-compose.yml
curl -fsSL -o .env ${RAW_URL}/deploy/.env.example
# edit .env: MCSM_VERSION, PANEL_PUBLIC_URL and DATA_ROOT
docker network create mcsm 2>/dev/null || true
sudo mkdir -p /srv/minecraft
docker compose up -d panel`;

const STEP_2 = `docker compose logs panel | grep "Initial setup token"
# open http://<ip>:8080 and create the password with that token, then
# in Nodes → Add node enter your DATA_ROOT as the "Data directory"
# and put the token it gives you in ENROLL_TOKEN in .env
docker compose up -d agent`;

const STEP_3 = `docker network create mcsm 2>/dev/null || true
docker run -d --name mcsm-agent --restart unless-stopped --stop-timeout 30 \\
  --network mcsm \\
  -v /var/run/docker.sock:/var/run/docker.sock \\
  -v /srv/minecraft:/srv/minecraft \\
  -v mcsm-agent-data:/var/lib/mcsm-agent \\
  -v /proc:/host/proc:ro -e HOST_PROC=/host/proc \\
  -e PANEL_URL=http://192.168.1.10:8080 \\
  -e ENROLL_TOKEN=<enrollment-token> \\
  -e DATA_ROOT=/srv/minecraft \\
  ghcr.io/javilobo8/mcsm-agent:${VERSION}`;

const STEPS = [
  {
    title: "Start the panel on your main machine",
    body: "Download the compose file and its .env, set the version, the panel's address and the directory for the worlds, create the shared network and start only the panel.",
    snippet: STEP_1,
    snippetTitle: "Main machine",
    doc: { slug: "installation", label: "Installation guide" },
  },
  {
    title: "Create your password and enroll the local agent",
    body: "The panel writes an initial setup token to its log: open the panel and create your password with it. Then, in Nodes → Add node, enter the same DATA_ROOT as the “Data directory”, put the token it gives you in ENROLL_TOKEN in the .env and start the agent.",
    snippet: STEP_2,
    snippetTitle: "Main machine",
    doc: { slug: "installation", label: "First start, step by step" },
  },
  {
    title: "Add your other machines",
    body: "On each machine, Nodes → Add node gives you this command with your address, a token that works once within 15 minutes and the agent image of your version. Prefer Compose? There is a node compose file too.",
    snippet: STEP_3,
    snippetTitle: "Other machines (example of the command the panel shows)",
    doc: { slug: "adding-nodes", label: "Adding nodes" },
  },
] as const;

export function QuickStart() {
  return (
    <Section id="quick-start" className="pt-24 sm:pt-32">
      <SectionHeading id="quick-start" title="Running in three steps">
        You need Linux with Docker Engine and the Compose plugin on each machine, Internet access for the images and the Minecraft
        downloads, and a directory for the worlds.
      </SectionHeading>

      <ol className="mt-12 space-y-12 lg:space-y-14">
        {STEPS.map((s, i) => (
          <li key={s.title} className="grid grid-cols-1 gap-x-6 gap-y-5 sm:grid-cols-[3rem_minmax(0,1fr)] lg:gap-x-8">
            <span
              aria-hidden="true"
              className="notch flex size-12 items-center justify-center bg-bedrock-2 font-pixel text-2xl font-semibold text-grass-bright shadow-[inset_0_-4px_0_rgb(0_0_0/0.35)]"
            >
              {i + 1}
            </span>
            <div className="max-w-[44rem]">
              <h3 className="text-xl font-semibold text-bone">
                <span className="sr-only">Step {i + 1}: </span>
                {s.title}
              </h3>
              <p className="mt-3 text-[0.9375rem] leading-relaxed text-fog">{s.body}</p>
              <Link
                to="/docs/$slug/"
                params={{ slug: s.doc.slug }}
                className="mt-4 inline-block text-sm font-medium text-grass-bright underline decoration-grass/45 underline-offset-4 hover:decoration-current"
              >
                {s.doc.label}
              </Link>
            </div>
            <Snippet display={s.snippet} title={s.snippetTitle} className="min-w-0 max-w-[56rem] sm:col-start-2" />
          </li>
        ))}
      </ol>
    </Section>
  );
}
