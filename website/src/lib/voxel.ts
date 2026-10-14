// Pure geometry for the isometric voxel illustration: projection, hidden-face culling, paint order and
// the "pixel texture" subdivision of each face.

export interface Vec {
  x: number;
  y: number;
}

/** Tile width, top diamond height and block height on screen. */
export const TILE = { w: 32, h: 16, v: 19 } as const;

export type Material = "grass" | "dirt" | "stone" | "rack" | "panel";
export type Face = "top" | "left" | "right";

export interface Block {
  x: number;
  y: number;
  z: number;
  material: Material;
}

/** World point → screen. +x goes down-right, +y down-left, +z up. */
export function project(wx: number, wy: number, wz: number): Vec {
  return { x: ((wx - wy) * TILE.w) / 2, y: ((wx + wy) * TILE.h) / 2 - wz * TILE.v };
}

const key = (x: number, y: number, z: number) => `${x},${y},${z}`;

/**
 * Visible faces (top, left = the +y face, right = the +x face) of every block, without the faces another
 * block covers, in the order to paint them: back to front, then bottom to top.
 */
export function paintOrder(blocks: Block[]): { block: Block; face: Face }[] {
  const occupied = new Set(blocks.map((b) => key(b.x, b.y, b.z)));
  const sorted = [...blocks].sort((a, b) => a.x + a.y + a.z - (b.x + b.y + b.z) || a.z - b.z);
  const out: { block: Block; face: Face }[] = [];
  for (const b of sorted) {
    if (!occupied.has(key(b.x, b.y + 1, b.z))) out.push({ block: b, face: "left" });
    if (!occupied.has(key(b.x + 1, b.y, b.z))) out.push({ block: b, face: "right" });
    if (!occupied.has(key(b.x, b.y, b.z + 1))) out.push({ block: b, face: "top" });
  }
  return out;
}

/** Origin and the two edge vectors of a face; for a side face `v` points down. */
function faceFrame(b: Block, face: Face): { o: Vec; u: Vec; v: Vec } {
  const { x, y, z } = b;
  const sub = (p: Vec, q: Vec) => ({ x: p.x - q.x, y: p.y - q.y });
  if (face === "top") {
    const o = project(x, y, z + 1);
    return { o, u: sub(project(x + 1, y, z + 1), o), v: sub(project(x, y + 1, z + 1), o) };
  }
  if (face === "left") {
    const o = project(x, y + 1, z + 1);
    return { o, u: sub(project(x + 1, y + 1, z + 1), o), v: { x: 0, y: TILE.v } };
  }
  const o = project(x + 1, y + 1, z + 1);
  return { o, u: sub(project(x + 1, y, z + 1), o), v: { x: 0, y: TILE.v } };
}

export interface Quad {
  row: number;
  col: number;
  points: [Vec, Vec, Vec, Vec];
}

/** The face split into n×n quads (row-major; row 0 is the top row of a side face). */
export function faceQuads(b: Block, face: Face, n: number): Quad[] {
  const { o, u, v } = faceFrame(b, face);
  const at = (i: number, j: number): Vec => ({ x: o.x + (u.x * i) / n + (v.x * j) / n, y: o.y + (u.y * i) / n + (v.y * j) / n });
  const quads: Quad[] = [];
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      quads.push({ row, col, points: [at(col, row), at(col + 1, row), at(col + 1, row + 1), at(col, row + 1)] });
    }
  }
  return quads;
}

/** Deterministic pseudo-random number in [0, 1) from integers (the texture noise). */
export function hash01(...n: number[]): number {
  let h = 2166136261;
  for (const v of n) {
    h ^= v | 0;
    h = Math.imul(h, 16777619);
    h ^= h >>> 13;
    h = Math.imul(h, 0x5bd1e995);
    h ^= h >>> 15;
  }
  return (h >>> 0) / 4294967296;
}
