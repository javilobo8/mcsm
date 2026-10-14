import { Link } from "@tanstack/react-router";
import { m, useReducedMotion } from "motion/react";
import { REPO_URL, RAW_URL } from "@/lib/site";
import { cn } from "@/lib/utils";
import { hash01 } from "@/lib/voxel";
import { BrowserFrame, screenshot } from "./browser-frame";
import { Snippet } from "./copy-button";
import { Ground } from "./ground";
import { GitHubMark } from "./logo";
import { VoxelScene } from "./voxel-scene";

// Stars over the sky, kept out of the text column (left half below the very top).
const STARS = Array.from({ length: 70 }, (_, i) => ({
  left: hash01(i, 1) * 100,
  top: hash01(i, 2) * 58,
  size: hash01(i, 3) < 0.18 ? 3 : 2,
  opacity: 0.25 + hash01(i, 4) * 0.5,
  twinkle: hash01(i, 5) < 0.2,
  delay: hash01(i, 6) * 5,
})).filter((s) => s.left > 54 || s.top < 7);

const COMPOSE_CMD = `curl -fsSL -o docker-compose.yml ${RAW_URL}/deploy/docker-compose.yml`;

const BADGES = ["MIT license", "Docker", "amd64 + arm64", "itzg/minecraft-server"];

export function Hero() {
  const reduced = useReducedMotion() ?? false;
  const rise = (delay: number) =>
    reduced ? {} : { initial: { opacity: 0, y: 12 }, animate: { opacity: 1, y: 0 }, transition: { delay, duration: 0.5, ease: [0.22, 1, 0.36, 1] as const } };

  return (
    <div className="relative isolate overflow-hidden bg-gradient-to-b from-[#121823] via-[#11151b] to-deepslate">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10">
        {STARS.map((s, i) => (
          <span
            key={i}
            // On narrow screens the text spans the whole width: keep only the stars above it.
            className={cn("absolute bg-bone", s.twinkle && "hero-star", s.top > 22 && "hidden lg:block")}
            style={{ left: `${s.left}%`, top: `${s.top}%`, width: s.size, height: s.size, opacity: s.opacity, animationDelay: `-${s.delay}s` }}
          />
        ))}
      </div>

      <div className="mx-auto grid max-w-[1240px] grid-cols-1 items-center gap-y-6 px-4 pt-10 sm:px-6 sm:pt-14 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] lg:gap-x-8 lg:px-8 lg:pt-20">
        <div className="min-w-0 lg:pb-6">
          <m.h1 {...rise(0)} className="font-pixel text-[2.6rem] leading-[1.02] font-semibold tracking-tight text-bone text-balance sm:text-[3.4rem] lg:text-[4rem]">
            One panel for every Minecraft server on your LAN
          </m.h1>
          <m.p {...rise(0.08)} className="mt-6 max-w-[36rem] text-[1.0625rem] leading-relaxed text-fog sm:text-[1.1875rem]">
            Create, run, back up and move Minecraft Java servers across the Docker machines in your home: a self-hosted panel, a small
            agent on each machine, and the <span className="text-bone">itzg/minecraft-server</span> image doing the heavy lifting.
          </m.p>
          <m.div {...rise(0.16)} className="mt-8 flex flex-wrap gap-3">
            <Link to="/docs/$slug/" params={{ slug: "installation" }} className="btn-block">
              Get started
            </Link>
            <a href={REPO_URL} className="btn-block btn-stone">
              <GitHubMark />
              View on GitHub
            </a>
          </m.div>
          <m.div {...rise(0.24)} className="mt-8 max-w-[38rem]">
            <Snippet
              title="Step one: download the compose file"
              display={`curl -fsSL -o docker-compose.yml \\\n${RAW_URL}/deploy/docker-compose.yml`}
              copy={COMPOSE_CMD}
              compact
            />
            <ul className="mt-4 flex flex-wrap gap-2" aria-label="At a glance">
              {BADGES.map((b) => (
                <li key={b} className="rounded-sm border border-cobble bg-bedrock/60 px-2.5 py-1 text-xs text-fog">
                  {b}
                </li>
              ))}
            </ul>
          </m.div>
        </div>
        <div className="order-first mx-auto w-full max-w-[22rem] sm:max-w-[30rem] lg:order-none lg:max-w-none">
          <VoxelScene className="h-auto w-full" />
        </div>
      </div>

      {/* The dashboard rises out of the ground: its empty lower half stays buried. */}
      <div className="relative mx-auto mt-14 max-w-[1240px] px-4 sm:px-6 lg:mt-20 lg:px-8">
        <div aria-hidden="true" className="absolute inset-x-0 -top-10 bottom-0 rounded-[3rem] bg-grass/10 blur-3xl" />
        <m.div
          initial={reduced ? false : { opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.35, duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
          className="relative aspect-[1440/760] overflow-hidden rounded-t-xl sm:aspect-[1440/600]"
        >
          <BrowserFrame
            src={screenshot("11-dashboard-node-cards")}
            alt="The panel's dashboard: two nodes with their CPU, RAM and disk, and a running server with its players, version, node and connection address."
            eager
          />
        </m.div>
      </div>
      <Ground className="z-20 -mt-6 sm:-mt-8" />
    </div>
  );
}
