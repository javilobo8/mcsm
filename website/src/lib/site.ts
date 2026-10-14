// Facts about the project used across the site (all from the repository, nothing invented).

export const SITE_NAME = "MC Server Manager";
export const VERSION = __MCSM_VERSION__;
export const REPO_URL = __REPO_URL__;
export const RELEASES_URL = `${REPO_URL}/releases`;
export const ISSUES_URL = `${REPO_URL}/issues`;
export const LICENSE_URL = `${REPO_URL}/blob/main/LICENSE`;
export const RAW_URL = "https://raw.githubusercontent.com/javilobo8/mcsm/main";

/** "Edit this page on GitHub" for a docs page. */
export const editUrl = (slug: string) => `${REPO_URL}/edit/main/website/src/content/docs/${slug}.md`;
