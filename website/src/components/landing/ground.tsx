import { hash01 } from "@/lib/voxel";
import { cn } from "@/lib/utils";

// A strip of grass-block side texture, 8 px per texture pixel: the horizon between the hero and the page.
const PX = 8;
const COLS = 16;
const ROWS = 6;
const GREENS = ["#6db349", "#63a940", "#5b9d3a", "#69ae45"];
const DIRT = ["#7a5034", "#6f482e", "#86593a", "#805537", "#6a452c"];

function tile(): string {
  const rects: string[] = [];
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const r = hash01(col, row, 7);
      const grass = row === 0 || (row === 1 && r < 0.5) || (row === 2 && r < 0.12);
      const list = grass ? GREENS : DIRT;
      rects.push(`<rect x="${col * PX}" y="${row * PX}" width="${PX}" height="${PX}" fill="${list[Math.floor(r * list.length)]}"/>`);
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${COLS * PX}" height="${ROWS * PX}" shape-rendering="crispEdges">${rects.join("")}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

const TILE = tile();

export function Ground({ className }: { className?: string }) {
  return (
    <div aria-hidden="true" className={cn("relative h-12", className)}>
      <div className="absolute inset-0" style={{ backgroundImage: TILE, backgroundRepeat: "repeat-x", backgroundSize: `${COLS * PX}px ${ROWS * PX}px` }} />
      {/* The dirt sinks into the page's deepslate. */}
      <div className="absolute inset-0 bg-gradient-to-b from-transparent from-30% to-deepslate" />
    </div>
  );
}
