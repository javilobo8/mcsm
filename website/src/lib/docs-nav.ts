// Pure ordering helpers for the documentation, shared by the app and the build.

export interface NavPage {
  slug: string;
  title: string;
  section: string;
  order: number;
}

/** Sorts by `order`. Two pages with the same order throw, naming both slugs. */
export function sortPages<T extends NavPage>(pages: T[]): T[] {
  const sorted = [...pages].sort((a, b) => a.order - b.order);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    if (prev.order === cur.order) {
      throw new Error(`docs pages "${prev.slug}" and "${cur.slug}" have the same order (${cur.order}): give each page its own`);
    }
  }
  return sorted;
}

/** Groups already sorted pages; sections appear in the order of their first page. */
export function groupBySection<T extends NavPage>(pages: T[]): { section: string; pages: T[] }[] {
  const groups: { section: string; pages: T[] }[] = [];
  const bySection = new Map<string, { section: string; pages: T[] }>();
  for (const page of pages) {
    let group = bySection.get(page.section);
    if (!group) {
      group = { section: page.section, pages: [] };
      bySection.set(page.section, group);
      groups.push(group);
    }
    group.pages.push(page);
  }
  return groups;
}

/** Previous and next page over the sorted list; {} for an unknown slug. */
export function neighbours<T extends NavPage>(pages: T[], slug: string): { prev?: T; next?: T } {
  const i = pages.findIndex((p) => p.slug === slug);
  if (i < 0) return {};
  const result: { prev?: T; next?: T } = {};
  if (i > 0) result.prev = pages[i - 1];
  if (i < pages.length - 1) result.next = pages[i + 1];
  return result;
}
