import { describe, expect, it } from "vitest";
import { faceQuads, hash01, paintOrder, project, TILE, type Block } from "../src/lib/voxel";

const b = (x: number, y: number, z: number): Block => ({ x, y, z, material: "dirt" });

describe("project", () => {
  it("maps the world axes onto the isometric grid", () => {
    expect(project(0, 0, 0)).toEqual({ x: 0, y: 0 });
    expect(project(1, 0, 0)).toEqual({ x: TILE.w / 2, y: TILE.h / 2 });
    expect(project(0, 1, 0)).toEqual({ x: -TILE.w / 2, y: TILE.h / 2 });
    expect(project(0, 0, 1)).toEqual({ x: 0, y: -TILE.v });
  });
});

describe("paintOrder", () => {
  it("keeps only the faces nothing covers", () => {
    const faces = paintOrder([b(0, 0, 0), b(0, 0, 1), b(1, 0, 0)]);
    const of = (x: number, y: number, z: number) => faces.filter((f) => f.block.x === x && f.block.y === y && f.block.z === z).map((f) => f.face);
    expect(of(0, 0, 0).sort()).toEqual(["left"]); // top covered by the block above, right by its neighbour
    expect(of(0, 0, 1).sort()).toEqual(["left", "right", "top"]);
    expect(of(1, 0, 0).sort()).toEqual(["left", "right", "top"]);
  });
  it("paints back to front and bottom to top", () => {
    const order = paintOrder([b(1, 1, 0), b(0, 0, 1), b(0, 0, 0)]).map((f) => `${f.block.x}${f.block.y}${f.block.z}`);
    expect(order.indexOf("000")).toBeLessThan(order.indexOf("001"));
    expect(order.lastIndexOf("001")).toBeLessThan(order.indexOf("110"));
  });
});

describe("faceQuads", () => {
  it("splits a face into n×n quads, row 0 at the top of a side face", () => {
    const quads = faceQuads(b(0, 0, 0), "left", 2);
    expect(quads).toHaveLength(4);
    expect(quads[0]!.row).toBe(0);
    const topRowY = Math.min(...quads.filter((q) => q.row === 0).flatMap((q) => q.points.map((p) => p.y)));
    const bottomRowY = Math.min(...quads.filter((q) => q.row === 1).flatMap((q) => q.points.map((p) => p.y)));
    expect(topRowY).toBeLessThan(bottomRowY);
  });
});

describe("hash01", () => {
  it("is deterministic and within [0, 1)", () => {
    expect(hash01(1, 2, 3)).toBe(hash01(1, 2, 3));
    expect(hash01(1, 2, 3)).not.toBe(hash01(3, 2, 1));
    for (let i = 0; i < 50; i++) {
      const v = hash01(i, i * 7, -i);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});
