import { useRef } from "react";
import { m, useInView, useReducedMotion } from "motion/react";
import { Section, SectionHeading } from "./section";

// Architecture, as in the README and the design spec: the panel (Fastify API + React web + SQLite) is the
// source of truth; one Go agent per machine dials out to it over WebSocket with protobuf, never listens,
// and reconciles its Docker to the desired specs.

const C = {
  box: "#171a1f",
  line: "#353b45",
  text: "#e9e7e1",
  fog: "#a0a7af",
  grass: "#72c04e",
  grassBright: "#8fd668",
  torch: "#f2b544",
};

type Pt = { x: number; y: number };

interface Layout {
  w: number;
  h: number;
  browser: { x: number; y: number; w: number; h: number };
  panel: { x: number; y: number; w: number; h: number };
  nodes: { x: number; y: number; w: number; h: number; name: string }[];
  /** Agent end → panel end, for each node. */
  links: { from: Pt; to: Pt; d: string; label?: Pt }[];
  browserLink: string;
  vertical: boolean;
}

function horizontal(): Layout {
  const panel = { x: 250, y: 120, w: 270, h: 220 };
  const nodes = [
    { x: 700, y: 16, w: 290, h: 128, name: "Main machine" },
    { x: 700, y: 166, w: 290, h: 128, name: "Node" },
    { x: 700, y: 316, w: 290, h: 128, name: "Node" },
  ];
  const links = nodes.map((n, i) => {
    const from = { x: n.x, y: n.y + 64 };
    const to = { x: panel.x + panel.w, y: panel.y + 70 + i * 40 };
    const cx = (from.x + to.x) / 2;
    return { from, to, d: `M${from.x} ${from.y} C${cx} ${from.y} ${cx} ${to.y} ${to.x} ${to.y}`, label: i === 1 ? { x: cx, y: to.y - 12 } : undefined };
  });
  return {
    w: 1000,
    h: 460,
    browser: { x: 10, y: 190, w: 160, h: 80 },
    panel,
    nodes,
    links,
    browserLink: `M170 230 L${panel.x} 230`,
    vertical: false,
  };
}

function vertical(): Layout {
  const panel = { x: 30, y: 110, w: 300, h: 150 };
  const nodes = [
    { x: 104, y: 330, w: 226, h: 104, name: "Main machine" },
    { x: 104, y: 454, w: 226, h: 104, name: "Node" },
    { x: 104, y: 578, w: 226, h: 104, name: "Node" },
  ];
  // Each link leaves its node to the left and climbs its own lane to the panel; lanes never cross.
  const links = nodes.map((n, i) => {
    const lane = 88 - i * 22;
    const from = { x: n.x, y: n.y + n.h / 2 };
    const to = { x: lane, y: panel.y + panel.h };
    return { from, to, d: `M${from.x} ${from.y} L${lane} ${from.y} L${to.x} ${to.y}`, label: i === 0 ? { x: 222, y: panel.y + panel.h + 40 } : undefined };
  });
  return {
    w: 360,
    h: 700,
    browser: { x: 100, y: 8, w: 160, h: 64 },
    panel,
    nodes,
    links,
    browserLink: `M180 72 L180 ${panel.y}`,
    vertical: true,
  };
}

function Box({ x, y, w, h, children, accent }: { x: number; y: number; w: number; h: number; children?: React.ReactNode; accent?: boolean }) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={8} fill={C.box} stroke={accent ? C.grass : C.line} strokeOpacity={accent ? 0.7 : 1} strokeWidth={1.25} />
      {children}
    </g>
  );
}

function Chip({ x, y, w, label, tone = "fog" }: { x: number; y: number; w: number; label: string; tone?: "fog" | "grass" }) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={26} rx={4} fill={tone === "grass" ? "rgb(114 192 78 / 0.14)" : "#22272e"} />
      <text x={x + w / 2} y={y + 17.5} textAnchor="middle" fontSize={12.5} fill={tone === "grass" ? C.grassBright : C.text} fontWeight={500}>
        {label}
      </text>
    </g>
  );
}

/** A row of small green blocks: the itzg containers of a node. */
function Servers({ x, y, count }: { x: number; y: number; count: number }) {
  return (
    <g>
      {Array.from({ length: count }, (_, i) => (
        <g key={i} transform={`translate(${x + i * 22} ${y})`}>
          <rect width={16} height={16} fill="#5b9d3a" />
          <rect width={16} height={5} fill="#78bf53" />
          <rect y={11} width={16} height={5} fill="#6f482e" />
        </g>
      ))}
    </g>
  );
}

function Diagram({ layout, play, reduced }: { layout: Layout; play: boolean; reduced: boolean }) {
  const { panel, browser, nodes, links, vertical: v } = layout;
  const show = reduced || play;
  const fade = (delay: number) =>
    reduced ? {} : { initial: { opacity: 0 }, animate: show ? { opacity: 1 } : { opacity: 0 }, transition: { delay, duration: 0.45 } };
  const panelChipW = v ? 84 : 76;

  return (
    <svg viewBox={`0 0 ${layout.w} ${layout.h}`} className="h-auto w-full" style={{ fontFamily: "var(--font-sans)" }} aria-hidden="true">
      {/* browser → panel */}
      <m.path d={layout.browserLink} stroke={C.line} strokeWidth={1.5} fill="none" {...fade(0.1)} />
      <m.g {...fade(0)}>
        <Box {...browser}>
          <text x={browser.x + browser.w / 2} y={browser.y + (v ? 28 : 34)} textAnchor="middle" fontSize={14} fontWeight={600} fill={C.text}>Your browser</text>
          <text x={browser.x + browser.w / 2} y={browser.y + (v ? 48 : 56)} textAnchor="middle" fontSize={12} fill={C.fog}>HTTP on the LAN</text>
        </Box>
      </m.g>

      {/* agent → panel connections */}
      {links.map((l, i) => (
        <g key={i}>
          <path id={`hiw-${v ? "v" : "h"}-${i}`} d={l.d} fill="none" stroke="none" />
          <m.path
            d={l.d}
            fill="none"
            stroke={C.grass}
            strokeOpacity={0.55}
            strokeWidth={1.75}
            strokeDasharray="4 5"
            initial={reduced ? false : { pathLength: 0 }}
            animate={show ? { pathLength: 1 } : { pathLength: 0 }}
            transition={{ delay: 0.45 + i * 0.15, duration: 0.8, ease: "easeInOut" }}
          />
          {/* the agent opens the connection: a dot where it starts */}
          <m.rect x={l.from.x - 4} y={l.from.y - 4} width={8} height={8} fill={C.grass} {...fade(0.4 + i * 0.15)} />
          {show && !reduced && (
            <>
              <rect width={7} height={7} x={-3.5} y={-3.5} fill={C.grassBright}>
                <animateMotion dur="2.8s" begin={`${1.4 + i * 0.7}s`} repeatCount="indefinite" keyPoints="1;0" keyTimes="0;1" calcMode="linear">
                  <mpath href={`#hiw-${v ? "v" : "h"}-${i}`} />
                </animateMotion>
              </rect>
              <rect width={7} height={7} x={-3.5} y={-3.5} fill={C.torch}>
                <animateMotion dur="2.8s" begin={`${2.8 + i * 0.7}s`} repeatCount="indefinite" calcMode="linear">
                  <mpath href={`#hiw-${v ? "v" : "h"}-${i}`} />
                </animateMotion>
              </rect>
            </>
          )}
          {l.label && (
            <m.text x={l.label.x} y={l.label.y} textAnchor="middle" fontSize={12} fill={C.fog} {...fade(1.1)}>
              WebSocket + protobuf
            </m.text>
          )}
        </g>
      ))}

      {/* panel */}
      <m.g {...fade(0.15)}>
        <Box {...panel} accent>
          <text x={panel.x + 20} y={panel.y + 34} fontSize={20} fontWeight={600} fill={C.text} style={{ fontFamily: "var(--font-pixel)" }}>Panel</text>
          <text x={panel.x + 20} y={panel.y + 56} fontSize={12} fill={C.fog}>The source of truth, port 8080</text>
          {(["Fastify API", "React web", "SQLite"] as const).map((label, i) =>
            v ? (
              <Chip key={label} x={panel.x + 20 + i * (panelChipW + 8)} y={panel.y + 96} w={panelChipW} label={label} />
            ) : (
              <Chip key={label} x={panel.x + 20} y={panel.y + 80 + i * 34} w={130} label={label} />
            ),
          )}
          {!v && (
            <g>
              <text x={panel.x + 166} y={panel.y + 97} fontSize={12} fill={C.fog}>Desired spec</text>
              <text x={panel.x + 166} y={panel.y + 113} fontSize={12} fill={C.fog}>of every server</text>
            </g>
          )}
        </Box>
      </m.g>

      {/* nodes */}
      {nodes.map((n, i) => (
        <m.g key={i} {...fade(0.25 + i * 0.1)}>
          <Box {...n}>
            <text x={n.x + (v ? 16 : 20)} y={n.y + (v ? 26 : 30)} fontSize={15} fontWeight={600} fill={C.text}>{n.name}</text>
            <Chip x={n.x + (v ? 16 : 20)} y={n.y + (v ? 38 : 46)} w={96} label="Agent (Go)" tone="grass" />
            <text x={n.x + (v ? 122 : 132)} y={n.y + (v ? 56 : 64)} fontSize={12} fill={C.fog}>reconciles Docker</text>
            <Servers x={n.x + (v ? 16 : 20)} y={n.y + (v ? 76 : 88)} count={i === 0 ? 2 : i === 1 ? 3 : 1} />
            <text x={n.x + (v ? 16 : 20) + (i === 1 ? 3 : i === 0 ? 2 : 1) * 22 + 6} y={n.y + (v ? 89 : 101)} fontSize={11.5} fill={C.fog}>
              {v ? "itzg containers" : "itzg/minecraft-server containers"}
            </text>
          </Box>
        </m.g>
      ))}
    </svg>
  );
}

const POINTS = [
  {
    title: "The panel holds the truth",
    body: "A Fastify API and a React web app with a SQLite database, in one image on port 8080. It stores what every server should be: its spec and whether it should be running.",
    swatch: "bg-grass",
  },
  {
    title: "Agents dial out, never in",
    body: "A small Go agent runs on every machine and opens a WebSocket to the panel, speaking protobuf. It listens on no port, and RCON stays on a private Docker network.",
    swatch: "bg-grass-bright",
  },
  {
    title: "Each agent reconciles its Docker",
    body: "It makes its machine match the desired specs, creating, recreating, starting and stopping the itzg/minecraft-server containers, and reports back what it observes.",
    swatch: "bg-torch",
  },
];

export function HowItWorks() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "0px 0px -15% 0px" });
  const reduced = useReducedMotion() ?? false;
  return (
    <Section id="how-it-works" className="pt-24 sm:pt-32">
      <SectionHeading id="how-it-works" title="One panel, one agent per machine">
        The panel decides; the agents make it so. Every machine that hosts servers runs an agent next to its Docker, and the panel
        never needs to reach into a machine.
      </SectionHeading>

      <div ref={ref} className="mt-12 rounded-xl border border-cobble bg-[#0d0f12] p-4 sm:p-8">
        <div className="hidden md:block">
          <Diagram layout={horizontal()} play={inView} reduced={reduced} />
        </div>
        <div className="mx-auto max-w-[24rem] md:hidden">
          <Diagram layout={vertical()} play={inView} reduced={reduced} />
        </div>
        <p className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-[0.8125rem] text-fog">
          <span className="inline-flex items-center gap-2"><span className="size-2.5 bg-grass-bright" aria-hidden="true" />Desired spec, from the panel</span>
          <span className="inline-flex items-center gap-2"><span className="size-2.5 bg-torch" aria-hidden="true" />Observed state, from the agent</span>
          <span className="inline-flex items-center gap-2"><span className="size-2.5 bg-grass" aria-hidden="true" />The agent opens the connection</span>
        </p>
      </div>

      <ul className="mt-10 grid grid-cols-1 gap-8 md:grid-cols-3">
        {POINTS.map((p) => (
          <li key={p.title}>
            <h3 className="flex items-center gap-2.5 text-[1.0625rem] font-semibold text-bone">
              <span className={`size-2.5 ${p.swatch}`} aria-hidden="true" />
              {p.title}
            </h3>
            <p className="mt-2 text-[0.9375rem] leading-relaxed text-fog">{p.body}</p>
          </li>
        ))}
      </ul>
    </Section>
  );
}
