/** Width and height of a WebP image from its header (lossy VP8, lossless VP8L or extended VP8X). */
export function webpSize(buf: Uint8Array): { width: number; height: number } | undefined {
  const ascii = (at: number, len: number) => String.fromCharCode(...buf.subarray(at, at + len));
  if (buf.length < 16 || ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WEBP") return undefined;
  const u16 = (at: number) => buf[at]! | (buf[at + 1]! << 8);
  const u24 = (at: number) => buf[at]! | (buf[at + 1]! << 8) | (buf[at + 2]! << 16);
  switch (ascii(12, 4)) {
    case "VP8 ":
      if (buf.length < 30 || buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return undefined;
      return { width: u16(26) & 0x3fff, height: u16(28) & 0x3fff };
    case "VP8L": {
      if (buf.length < 25 || buf[20] !== 0x2f) return undefined;
      const bits = (buf[21]! | (buf[22]! << 8) | (buf[23]! << 16) | (buf[24]! << 24)) >>> 0;
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    case "VP8X":
      if (buf.length < 30) return undefined;
      return { width: u24(24) + 1, height: u24(27) + 1 };
    default:
      return undefined;
  }
}
