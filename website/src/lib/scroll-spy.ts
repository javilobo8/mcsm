/**
 * The heading the reader is in: the last one whose top (relative to the viewport) has crossed `line`,
 * or the last heading once the page is scrolled to the bottom (short final sections never reach the line).
 */
export function activeHeading(headings: { id: string; top: number }[], line: number, atBottom: boolean): string | undefined {
  if (headings.length === 0) return undefined;
  if (atBottom) return headings[headings.length - 1]!.id;
  let active: string | undefined;
  for (const h of headings) {
    if (h.top <= line) active = h.id;
    else break;
  }
  return active;
}
