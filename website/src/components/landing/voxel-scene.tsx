import { useMemo } from "react";
import { m, useReducedMotion } from "motion/react";
import { faceQuads, hash01, paintOrder, project, type Block, type Face, type Material, type Vec } from "@/lib/voxel";

// The hero illustration: a few floating islands, one per machine of the LAN. The main one carries the panel
// (a block with a small dashboard on it) and its own servers; the others carry servers only. Each node's
// connection to the panel carries the desired spec down (green) and the observed state up (gold).

const N = 4; // texture pixels per block edge

const PALETTE: Record<Exclude<Material, "rack" | "panel">, { top: string[]; side: string[] }> = {
  grass: { top: ["#6db349", "#63a940", "#78bf53", "#5b9d3a", "#69ae45"], side: ["#86593a", "#7a5034", "#8f6342", "#6f482e"] },
  dirt: { top: ["#86593a", "#7a5034", "#8f6342", "#6f482e"], side: ["#86593a", "#7a5034", "#8f6342", "#6f482e", "#805537"] },
  stone: { top: ["#6c7178", "#62676e", "#757a81", "#5b6067"], side: ["#6c7178", "#62676e", "#757a81", "#5b6067", "#686d74"] },
};
const GRASS_FRINGE = ["#6db349", "#63a940", "#5b9d3a", "#69ae45"];
const RACK = ["#2e343c", "#2a3038", "#333a43"];
const RACK_SLOT = "#1b1f25";
const LED_ON = "#8fd668";
const LED_WARM = "#f2b544";
const SCREEN = "#0f1a10";
const SHADE: Record<Face, number> = { top: 1, left: 0.8, right: 0.62 };

function shade(hex: string, f: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const c = (s: number) => Math.round(((n >> s) & 255) * f).toString(16).padStart(2, "0");
  return `#${c(16)}${c(8)}${c(0)}`;
}

type Pixel = { points: string; fill: string; led?: "on" | "warm"; seed: number };

/** Colour of one texture pixel of a face. */
function pixel(b: Block, face: Face, row: number, col: number, warm: boolean): { fill: string; led?: "on" | "warm" } {
  const r = hash01(b.x, b.y, b.z, face.length, row, col);
  const pick = (list: string[]) => list[Math.floor(r * list.length)]!;
  if (b.material === "rack") {
    if (face === "top") return { fill: shade(pick(RACK), 1.15) };
    if (row === 1 || row === 3) return { fill: shade(RACK_SLOT, SHADE[face]) };
    if (row === 0 && col === 3 && face === "left") return { fill: warm ? LED_WARM : LED_ON, led: warm ? "warm" : "on" };
    if (row === 2 && col === 3 && face === "left") return { fill: LED_ON, led: "on" };
    return { fill: shade(pick(RACK), SHADE[face]) };
  }
  if (b.material === "panel") {
    if (face === "top") return { fill: col === 1 && row === 1 ? "#72c04e" : shade(pick(RACK), 1.25) };
    if (face === "left") {
      if (row === 0 || row === 3) return { fill: shade(pick(RACK), 0.9) };
      const lit = row === 1 ? col <= 2 : col <= 1; // two meter bars, like the node cards of the dashboard
      return { fill: lit ? (col === 0 ? "#8fd668" : "#72c04e") : SCREEN, led: lit ? "on" : undefined };
    }
    return { fill: row === 0 && col === 0 ? LED_ON : shade(pick(RACK), SHADE[face]), led: row === 0 && col === 0 ? "on" : undefined };
  }
  const pal = PALETTE[b.material];
  if (face === "top") return { fill: pick(pal.top) };
  if (b.material === "grass" && (row === 0 || (row === 1 && r < 0.45))) return { fill: shade(GRASS_FRINGE[Math.floor(r * 4)]!, SHADE[face]) };
  return { fill: shade(pick(pal.side), SHADE[face]) };
}

/** Blocks from a layer drawing: rows are y, columns are x; X = the layer's material, R = rack, P = panel. */
function layer(z: number, material: Material, rows: string[]): Block[] {
  return rows.flatMap((row, y) =>
    [...row].flatMap((ch, x) => {
      if (ch === "X") return [{ x, y, z, material }];
      if (ch === "R") return [{ x, y, z, material: "rack" as const }];
      if (ch === "P") return [{ x, y, z, material: "panel" as const }];
      return [];
    }),
  );
}

interface Island {
  id: string;
  at: Vec; // screen offset
  blocks: Block[];
  anchor: Vec; // where the connection meets the island (local screen coordinates)
  warm?: string; // "x,y,z" of the rack whose first LED is gold (a backup in progress)
  delay: number; // float phase, seconds
}

const ISLANDS: Island[] = [
  {
    id: "main",
    at: { x: 0, y: 0 },
    blocks: [
      ...layer(0, "grass", ["XXXX.", "XXXXX", "XXXXX", "XXXX.", ".XX.."]),
      ...layer(-1, "dirt", ["XXX..", "XXXXX", "XXXX.", "XXX..", ".X..."]),
      ...layer(-2, "stone", [".XX..", "XXXX.", ".XX..", ".X..."]),
      ...layer(-3, "stone", ["", ".XX", "..X"]),
      ...layer(-4, "stone", ["", "", "..X"]),
      ...layer(1, "rack", ["...R", ".P", "", "..R.", ""]),
      ...layer(2, "rack", ["", "", "", "..R"]),
    ],
    anchor: project(1.5, 1.5, 2.2),
    delay: 0,
  },
  {
    id: "east",
    at: { x: 150, y: -112 },
    blocks: [
      ...layer(0, "grass", ["XXX", "XXX", ".XX"]),
      ...layer(-1, "dirt", ["XX.", "XXX", ".X."]),
      ...layer(-2, "stone", [".X", "X"]),
      ...layer(1, "rack", ["R", ".", "..R"]),
      ...layer(2, "rack", ["R"]),
    ],
    anchor: project(0.5, 0.5, 3.3),
    warm: "0,0,2",
    delay: 1.6,
  },
  {
    id: "west",
    at: { x: -160, y: -40 },
    blocks: [
      ...layer(0, "grass", ["XX", "XXX", "XX"]),
      ...layer(-1, "dirt", ["XX", ".XX"]),
      ...layer(-2, "stone", [".X"]),
      ...layer(1, "rack", ["", ".R"]),
    ],
    anchor: project(1.5, 1.5, 2.3),
    delay: 3.1,
  },
  {
    id: "south",
    at: { x: 168, y: 72 },
    blocks: [
      ...layer(0, "grass", ["XX", "XX"]),
      ...layer(-1, "dirt", ["X", "XX"]),
      ...layer(-2, "stone", ["", "X"]),
      ...layer(1, "rack", ["R"]),
    ],
    anchor: project(0.5, 0.5, 2.3),
    delay: 2.2,
  },
];

const fmt = (n: number) => Math.round(n * 100) / 100;

function islandPixels(island: Island): Pixel[] {
  const out: Pixel[] = [];
  for (const { block, face } of paintOrder(island.blocks)) {
    const warm = island.warm === `${block.x},${block.y},${block.z}`;
    for (const q of faceQuads(block, face, N)) {
      const { fill, led } = pixel(block, face, q.row, q.col, warm);
      const points = q.points.map((p) => `${fmt(p.x)},${fmt(p.y)}`).join(" ");
      out.push({ points, fill, led, seed: hash01(block.x, block.y, block.z, q.row, q.col) });
    }
  }
  return out;
}

/** Curved link from a node's anchor to the panel's, bowing upwards. */
function linkPath(from: Vec, to: Vec): string {
  const mid = { x: (from.x + to.x) / 2, y: Math.min(from.y, to.y) - 46 };
  return `M${fmt(from.x)} ${fmt(from.y)} Q${fmt(mid.x)} ${fmt(mid.y)} ${fmt(to.x)} ${fmt(to.y)}`;
}

export function VoxelScene({ className }: { className?: string }) {
  const reduced = useReducedMotion() ?? false;
  const scene = useMemo(() => {
    const islands = ISLANDS.map((i) => ({ ...i, pixels: islandPixels(i) }));
    const main = islands[0]!;
    const panel = { x: main.at.x + main.anchor.x, y: main.at.y + main.anchor.y };
    const links = islands.slice(1).map((i) => ({ id: i.id, d: linkPath({ x: i.at.x + i.anchor.x, y: i.at.y + i.anchor.y }, panel) }));
    // Bounds of everything drawn, plus room for the float and the glow.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const i of islands) {
      for (const p of i.pixels) {
        for (const pair of p.points.split(" ")) {
          const [x, y] = pair.split(",").map(Number) as [number, number];
          minX = Math.min(minX, x + i.at.x);
          maxX = Math.max(maxX, x + i.at.x);
          minY = Math.min(minY, y + i.at.y);
          maxY = Math.max(maxY, y + i.at.y);
        }
      }
    }
    const pad = 28;
    return { islands, links, panel, box: { x: minX - pad, y: minY - pad - 40, w: maxX - minX + 2 * pad, h: maxY - minY + 2 * pad + 40 } };
  }, []);

  const { box } = scene;
  return (
    <svg
      viewBox={`${fmt(box.x)} ${fmt(box.y)} ${fmt(box.w)} ${fmt(box.h)}`}
      className={className}
      role="img"
      aria-label="Floating grass islands, one per machine: the main one holds the panel, every island holds Minecraft servers, and each is linked to the panel."
      shapeRendering="crispEdges"
      overflow="visible"
    >
      <defs>
        <radialGradient id="vs-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#72c04e" stopOpacity="0.22" />
          <stop offset="100%" stopColor="#72c04e" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="vs-torch" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#f2b544" stopOpacity="0.16" />
          <stop offset="100%" stopColor="#f2b544" stopOpacity="0" />
        </radialGradient>
      </defs>

      <ellipse cx={scene.panel.x} cy={scene.panel.y + 70} rx={250} ry={150} fill="url(#vs-glow)" />
      <ellipse cx={scene.panel.x} cy={scene.panel.y + 4} rx={70} ry={50} fill="url(#vs-torch)" />

      <g fill="none" shapeRendering="geometricPrecision">
        {scene.links.map((l, i) => (
          <m.path
            key={l.id}
            id={`vs-link-${l.id}`}
            d={l.d}
            stroke="#72c04e"
            strokeOpacity={0.45}
            strokeWidth={1.5}
            strokeDasharray="3 5"
            initial={reduced ? false : { pathLength: 0, opacity: 0 }}
            animate={{ pathLength: 1, opacity: 1 }}
            transition={{ delay: 0.75 + i * 0.12, duration: 0.7, ease: "easeOut" }}
          />
        ))}
        {!reduced &&
          scene.links.map((l, i) => (
            <g key={`p-${l.id}`}>
              {/* desired spec: panel → node */}
              <rect width="5" height="5" x="-2.5" y="-2.5" fill="#8fd668" opacity="0">
                <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.1;0.9;1" dur="3.4s" begin={`${1.6 + i * 0.9}s`} repeatCount="indefinite" />
                <animateMotion dur="3.4s" begin={`${1.6 + i * 0.9}s`} repeatCount="indefinite" keyPoints="1;0" keyTimes="0;1" calcMode="linear">
                  <mpath href={`#vs-link-${l.id}`} />
                </animateMotion>
              </rect>
              {/* observed state: node → panel */}
              <rect width="5" height="5" x="-2.5" y="-2.5" fill="#f2b544" opacity="0">
                <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.1;0.9;1" dur="3.4s" begin={`${3.3 + i * 0.9}s`} repeatCount="indefinite" />
                <animateMotion dur="3.4s" begin={`${3.3 + i * 0.9}s`} repeatCount="indefinite" calcMode="linear">
                  <mpath href={`#vs-link-${l.id}`} />
                </animateMotion>
              </rect>
            </g>
          ))}
      </g>

      {scene.islands.map((island, i) => (
        <g key={island.id} transform={`translate(${island.at.x} ${island.at.y})`}>
          <g className="voxel-float" style={{ animationDelay: `-${island.delay}s` }}>
            <m.g
              initial={reduced ? false : { y: -36, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ delay: 0.1 + i * 0.13, type: "spring", stiffness: 140, damping: 16 }}
            >
              {island.pixels.map((p, j) => (
                <polygon
                  key={j}
                  points={p.points}
                  fill={p.fill}
                  stroke={p.fill}
                  strokeWidth={0.6}
                  className={p.led ? "voxel-led" : undefined}
                  style={p.led ? { animationDelay: `-${(p.seed * 6).toFixed(2)}s` } : undefined}
                />
              ))}
            </m.g>
          </g>
        </g>
      ))}
    </svg>
  );
}
