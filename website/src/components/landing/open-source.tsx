import { Link } from "@tanstack/react-router";
import { ISSUES_URL, LICENSE_URL, REPO_URL } from "@/lib/site";
import { GitHubMark } from "./logo";
import { Section, SectionHeading } from "./section";

const STACK = [
  ["Go", "The agent on every machine"],
  ["TypeScript and Fastify", "The panel's API"],
  ["React", "The panel's web app"],
  ["SQLite", "The panel's database"],
  ["Protocol Buffers and buf", "The protocol between panel and agents"],
  ["Docker", "Servers, panel and agents, with images for amd64 and arm64"],
] as const;

export function OpenSource() {
  return (
    <Section id="open-source" className="pt-24 pb-24 sm:pt-32 sm:pb-32">
      <div className="grid grid-cols-1 gap-12 lg:grid-cols-2 lg:gap-16">
        <div>
          <SectionHeading id="open-source" title="Open source, MIT licensed">
            The panel, the agent and their protocol live in one repository. Read the code, report a bug, or build the images yourself
            from source.
          </SectionHeading>
          <div className="mt-8 flex flex-wrap gap-3">
            <a href={REPO_URL} className="btn-block">
              <GitHubMark />
              Browse the repository
            </a>
            <a href={ISSUES_URL} className="btn-block btn-stone">
              Report an issue
            </a>
          </div>
          <p className="mt-6 text-sm text-fog">
            Want to contribute? Start with the{" "}
            <Link to="/docs/$slug/" params={{ slug: "development" }} className="text-grass-bright underline decoration-grass/45 underline-offset-4 hover:decoration-current">
              development guide
            </Link>{" "}
            or read the{" "}
            <a href={LICENSE_URL} className="text-grass-bright underline decoration-grass/45 underline-offset-4 hover:decoration-current">
              license
            </a>
            .
          </p>
        </div>
        <dl className="divide-y divide-cobble self-start rounded-lg border border-cobble">
          {STACK.map(([tech, role]) => (
            <div key={tech} className="grid grid-cols-1 gap-1 px-5 py-3.5 sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-4">
              <dt className="font-medium text-bone">{tech}</dt>
              <dd className="text-[0.9375rem] text-fog">{role}</dd>
            </div>
          ))}
        </dl>
      </div>
    </Section>
  );
}
