/**
 * Deterministic pseudo-random number in [0, 1) from integers: the stars and the grass texture of the login
 * page. The same function as the website's (website/src/lib/voxel.ts), so both draw the same scene.
 */
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
