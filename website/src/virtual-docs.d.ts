declare module "virtual:docs" {
  export interface DocPage {
    slug: string;
    title: string;
    description: string;
    section: string;
    order: number;
    /** Trusted HTML compiled at build time from website/src/content/docs/<slug>.md. */
    html: string;
    toc: { depth: 2 | 3; id: string; text: string }[];
  }
  /** Sorted by `order`. */
  export const pages: DocPage[];
}
