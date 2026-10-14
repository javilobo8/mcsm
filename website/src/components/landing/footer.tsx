import { Link } from "@tanstack/react-router";
import { ISSUES_URL, LICENSE_URL, RELEASES_URL, REPO_URL, VERSION } from "@/lib/site";
import { cn } from "@/lib/utils";
import { Wordmark } from "./logo";

const linkClass = "text-sm text-fog transition-colors hover:text-bone";

function Column({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h2 className="text-sm font-semibold text-bone">{title}</h2>
      <ul className="mt-3 space-y-2">{children}</ul>
    </div>
  );
}

const DocLink = ({ slug, children }: { slug: string; children: React.ReactNode }) => (
  <li>
    <Link to="/docs/$slug/" params={{ slug }} className={linkClass}>{children}</Link>
  </li>
);

export function Footer({ wide = false }: { wide?: boolean }) {
  const container = cn("mx-auto px-4 sm:px-6 lg:px-8", wide ? "max-w-[1400px]" : "max-w-[1240px]");
  return (
    <footer className="border-t border-cobble bg-deepslate">
      <div className={cn(container, "grid gap-10 py-12 md:grid-cols-[1.4fr_repeat(3,1fr)]")}>
        <div className="max-w-xs">
          <Wordmark />
          <p className="mt-4 text-sm leading-relaxed text-fog">
            A self-hosted panel for the Minecraft Java servers on the Docker machines of your LAN. Open source, MIT licensed.
          </p>
        </div>
        <Column title="Product">
          <li><Link to="/" hash="features" className={linkClass}>Features</Link></li>
          <li><Link to="/" hash="how-it-works" className={linkClass}>How it works</Link></li>
          <li><Link to="/" hash="quick-start" className={linkClass}>Quick start</Link></li>
          <li><Link to="/" hash="security" className={linkClass}>Security</Link></li>
        </Column>
        <Column title="Documentation">
          <DocLink slug="introduction">Introduction</DocLink>
          <DocLink slug="installation">Installation</DocLink>
          <DocLink slug="adding-nodes">Adding nodes</DocLink>
          <DocLink slug="updating">Updating</DocLink>
        </Column>
        <Column title="Project">
          <li><a href={REPO_URL} className={linkClass}>Source code</a></li>
          <li><a href={RELEASES_URL} className={linkClass}>Releases</a></li>
          <li><a href={ISSUES_URL} className={linkClass}>Issues</a></li>
          <DocLink slug="development">Contributing</DocLink>
        </Column>
      </div>
      <div className="border-t border-cobble/70">
        <div className={cn(container, "flex flex-col gap-2 py-6 text-xs leading-relaxed text-fog lg:flex-row lg:items-center lg:justify-between")}>
          <p>
            Version {VERSION}. Released under the <a href={LICENSE_URL} className="underline underline-offset-2 hover:text-bone">MIT license</a>.
          </p>
          <p>Minecraft is a trademark of Mojang. MC Server Manager is not an official Minecraft product and is not affiliated with Mojang or Microsoft.</p>
        </div>
      </div>
    </footer>
  );
}
