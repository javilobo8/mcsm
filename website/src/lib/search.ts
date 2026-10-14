// Pure search over the documentation: page titles, descriptions and h2/h3 headings.

export interface SearchEntry {
  slug: string;
  /** Heading id; undefined for the page itself. */
  anchor?: string;
  /** What the result shows: the page title or the heading text. */
  title: string;
  /** Title of the page the entry belongs to. */
  page: string;
  section: string;
  /** Description for a page entry, the heading for a heading entry. */
  text: string;
}

interface IndexablePage {
  slug: string;
  title: string;
  description: string;
  section: string;
  toc: { id: string; text: string }[];
}

/** One entry per page followed by one per heading of that page, in order. */
export function buildSearchIndex(pages: IndexablePage[]): SearchEntry[] {
  const index: SearchEntry[] = [];
  for (const p of pages) {
    index.push({ slug: p.slug, anchor: undefined, title: p.title, page: p.title, section: p.section, text: p.description });
    for (const h of p.toc) {
      index.push({ slug: p.slug, anchor: h.id, title: h.text, page: p.title, section: p.section, text: h.text });
    }
  }
  return index;
}

/**
 * Every word of the query must appear (case-insensitive) in the entry's title, page or text.
 * Ranking: title starts with the query, then title contains it, then the rest; ties keep index order.
 */
export function search(index: SearchEntry[], query: string, limit = 8): SearchEntry[] {
  const q = query.trim().toLowerCase().replace(/\s+/g, " ");
  if (!q) return [];
  const words = q.split(" ");
  const ranked: { entry: SearchEntry; rank: number; i: number }[] = [];
  index.forEach((entry, i) => {
    const title = entry.title.toLowerCase();
    const haystack = `${title} ${entry.page.toLowerCase()} ${entry.text.toLowerCase()}`;
    if (!words.every((w) => haystack.includes(w))) return;
    const rank = title.startsWith(q) ? 0 : title.includes(q) ? 1 : 2;
    ranked.push({ entry, rank, i });
  });
  ranked.sort((a, b) => a.rank - b.rank || a.i - b.i);
  return ranked.slice(0, Math.max(0, limit)).map((r) => r.entry);
}
