import { readFileSync } from "node:fs";
import type { Page, Route } from "@playwright/test";

/**
 * The content browser talks to Modrinth through the panel's own /api/content/** routes. Upstream data changes every day and
 * the E2E nodes must not depend on the Internet, so the browser's requests are answered from recorded fixtures here.
 * Everything else (the spec PATCH, the backup job, the agent, the container) is real.
 */
const dir = new URL("./fixtures/content/", import.meta.url);
const fixture = <T>(name: string): T => JSON.parse(readFileSync(new URL(name, dir), "utf8")) as T;
const icon = readFileSync(new URL("icon.png", dir));

type Json = Record<string, unknown>;
const lookup = fixture<Record<string, Json>>("lookup.json");
const updates = fixture<Record<string, Json>>("updates.json");
const packInfo = fixture<Record<string, Json>>("pack-info.json");
const packProjects = fixture<Record<string, Json>>("project-pack.json");

/** Content requests the stub saw, in order: the specs assert on what the web asked for. */
export interface ContentCalls { all: string[] }

const packVersions = fixture<Record<string, Json>>("versions-pack.json");

function answer(method: string, path: string, query: URLSearchParams, body: Json | null): unknown {
  let m: RegExpExecArray | null;
  if (method === "POST" && path === "/api/content/lookup") {
    const entries = (body?.entries ?? []) as { list: string; entry: string }[];
    return {
      entries: entries.map(({ list, entry }) => {
        const project = entry.split(":")[0]!;
        const meta = lookup[project] ?? { resolved: false, projectId: null, slug: null, name: null, author: null, iconUrl: null, versionLabel: null, versionType: null, gameVersions: [], loaders: [], dependencies: [], unavailable: null };
        return { ...meta, list, raw: entry, versionId: entry.includes(":") ? entry.split(":")[1] : null };
      }),
    };
  }
  if (method === "POST" && path === "/api/content/resolve") return fixture("resolve-sodium.json");
  if (method === "POST" && path === "/api/content/updates") {
    const entries = (body?.entries ?? []) as string[];
    return { updates: entries.map((entry) => updates[entry] ? { entry, ...updates[entry] } : { entry, projectId: null, currentVersionId: null, compatible: true, checked: true, latest: null }) };
  }
  if ((m = /^\/api\/content\/modrinth\/search$/.exec(path))) return fixture(query.get("kind") === "modpack" ? "search-packs.json" : "search-mods.json");
  if (/^\/api\/content\/modrinth\/categories$/.test(path)) return fixture("categories.json");
  if ((m = /^\/api\/content\/modrinth\/projects\/([A-Za-z0-9_-]+)$/.exec(path))) return packProjects[m[1]!] ?? fixture("project-sodium.json");
  if ((m = /^\/api\/content\/modrinth\/projects\/([A-Za-z0-9_-]+)\/versions$/.exec(path))) return packVersions[m[1]!] ?? fixture("versions-sodium.json");
  if ((m = /^\/api\/content\/modrinth\/packs\/([A-Za-z0-9_-]+)\/([A-Za-z0-9]+)$/.exec(path))) {
    const [, project, versionId] = m;
    const info = packInfo[project!];
    // The label follows the version asked for, like the real adapter's.
    const label = ((packVersions[project!]?.versions ?? []) as { versionId: string; label: string }[]).find((v) => v.versionId === versionId)?.label;
    return info ? { ...info, versionId, ...(label ? { versionLabel: label } : {}) } : undefined;
  }
  return undefined;
}

/** Routes /api/content/** of `page` to the fixtures. Unknown routes answer the panel's own 404, never the Internet. */
export async function stubContent(page: Page): Promise<ContentCalls> {
  const calls: ContentCalls = { all: [] };
  await page.route("**/api/content/**", async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    calls.all.push(`${req.method()} ${url.pathname}`);
    if (url.pathname === "/api/content/image") return route.fulfill({ status: 200, contentType: "image/png", body: icon, headers: { "cache-control": "private, max-age=86400" } });
    const body = answer(req.method(), url.pathname, url.searchParams, req.method() === "POST" ? (req.postDataJSON() as Json) : null);
    if (body === undefined) return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Project not found on Modrinth" }) });
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  return calls;
}
