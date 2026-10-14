import { Link } from "@tanstack/react-router";
import { Section, SectionHeading } from "./section";

// From the README's Security section.
const HARDENED = [
  ["Servers without extra privileges", "No capabilities beyond the five the image needs to start, no-new-privileges, and limits on processes and memory."],
  ["Agents never listen", "They connect out to the panel. RCON travels over the internal Docker network and is never published."],
  ["A filtered socket for mc-router", "The router never gets the Docker socket, only the agent's filtered one: it sees and starts only servers with a router hostname."],
  ["A setup token for the first password", "Nobody who reaches the panel before you, nor a website through DNS rebinding, can set the password."],
  ["Strict headers, limited logins", "A restrictive Content Security Policy, frame-ancestors 'none' and a global limit on failed logins."],
] as const;

const LIMITS = [
  ["A trusted home LAN", "There is no TLS between the browser, the panel and the agents, and the agent doesn't authenticate the panel."],
  ["One administrator", "A single password, no user accounts."],
  ["Docker is root", "Whoever controls the panel effectively has root on every node. Never expose port 8080 to the Internet."],
  ["Migrate from nodes you trust", "A migration runs the source's world, plugins and mods on the target."],
] as const;

function List({ items, tone }: { items: readonly (readonly [string, string])[]; tone: "grass" | "torch" }) {
  return (
    <ul className="mt-6 space-y-5">
      {items.map(([title, body]) => (
        <li key={title} className="grid grid-cols-[0.625rem_minmax(0,1fr)] gap-x-3.5">
          <span aria-hidden="true" className={`mt-[0.45rem] size-2.5 ${tone === "grass" ? "bg-grass" : "bg-torch"}`} />
          <div>
            <p className="font-medium text-bone">{title}</p>
            <p className="mt-1 text-[0.9375rem] leading-relaxed text-fog">{body}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function Security() {
  return (
    <Section id="security" className="pt-24 sm:pt-32">
      <SectionHeading id="security" title="Locked down, and honest about it">
        The panel can run any server on any of your machines, so it is built to keep that power contained, and it tells you plainly
        where its protection ends.
      </SectionHeading>
      <div className="mt-10 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="rounded-lg border border-cobble bg-bedrock/70 p-6 sm:p-7">
          <h3 className="text-lg font-semibold text-bone">What it does for you</h3>
          <List items={HARDENED} tone="grass" />
        </div>
        <div className="rounded-lg border border-torch/25 bg-torch/[0.04] p-6 sm:p-7">
          <h3 className="text-lg font-semibold text-bone">What it expects from you</h3>
          <List items={LIMITS} tone="torch" />
          <Link
            to="/docs/$slug/"
            params={{ slug: "security" }}
            className="mt-7 inline-block text-sm font-medium text-torch underline decoration-torch/40 underline-offset-4 hover:decoration-current"
          >
            Read the security model
          </Link>
        </div>
      </div>
    </Section>
  );
}
