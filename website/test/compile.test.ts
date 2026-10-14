import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileDoc } from "../build/docs/compile";

const repoRoot = path.join(__dirname, "fixtures/repo");
const opts = { base: "/mcsm/", repoRoot, file: "t.md" };

describe("compileDoc", () => {
  it("builds the TOC from h2/h3 with GitHub slugs and keeps every heading id", async () => {
    const d = await compileDoc("## Ports and firewall\n\n### Space, files and jobs\n\n#### Deep one\n", opts);
    expect(d.toc).toEqual([
      { depth: 2, id: "ports-and-firewall", text: "Ports and firewall" },
      { depth: 3, id: "space-files-and-jobs", text: "Space, files and jobs" },
    ]);
    expect(d.headingIds).toContain("deep-one");
    expect(d.html).toContain('id="ports-and-firewall"');
  });
  it("rejects an h1 in the body", async () => {
    await expect(compileDoc("# Title\n", opts)).rejects.toThrow(/t\.md/);
  });
  it("rewrites internal links with the base and records them", async () => {
    const d = await compileDoc("See [backups](/docs/backups#restoring) and [intro](/docs/introduction).\n", opts);
    expect(d.links).toEqual(["/docs/backups#restoring", "/docs/introduction"]);
    expect(d.html).toContain('href="/mcsm/docs/backups/#restoring"');
    expect(d.html).toContain('href="/mcsm/docs/introduction/"');
  });
  it("opens external links in a new tab", async () => {
    const d = await compileDoc("[itzg](https://github.com/itzg/docker-minecraft-server)\n", opts);
    expect(d.html).toMatch(/href="https:\/\/github\.com\/itzg\/docker-minecraft-server"[^>]*target="_blank"/);
    expect(d.html).toContain('rel="noopener noreferrer"');
  });
  it("rewrites images with the base and records them", async () => {
    const d = await compileDoc("![Backups tab](/screenshots/06-backups.webp)\n", opts);
    expect(d.images).toEqual(["/screenshots/06-backups.webp"]);
    expect(d.html).toContain('src="/mcsm/screenshots/06-backups.webp"');
  });
  it("turns GitHub alerts into callouts", async () => {
    const d = await compileDoc("> [!WARNING]\n> Don't expose it to the Internet.\n", opts);
    expect(d.html).toContain('class="callout callout-warning"');
    expect(d.html).toContain("Don't expose it");
    expect(d.html).not.toContain("[!WARNING]");
  });
  it("highlights code and labels the language", async () => {
    const d = await compileDoc("```bash\ndocker compose up -d\n```\n", opts);
    expect(d.html).toContain('data-lang="bash"');
    expect(d.html).toContain("<pre");
  });
  it("includes one of the deploy/ files of the contract", async () => {
    const d = await compileDoc('```yaml include="deploy/docker-compose.yml"\n```\n', opts);
    expect(d.html).toContain("example-service");
    expect(d.html).toContain('data-file="deploy/docker-compose.yml"');
  });
  it.each(["../secret.txt", "/etc/passwd", "deploy/../../x", "README.md", "deploy/.env", "deploy/docker-compose.build.yml", "deploy/../deploy/docker-compose.yml"])(
    "refuses to include %s",
    async (p) => {
      await expect(compileDoc(`\`\`\`yaml include="${p}"\n\`\`\`\n`, opts)).rejects.toThrow(/include ".*" is not allowed/);
    },
  );
  it("fails on a missing include", async () => {
    await expect(compileDoc('```yaml include="deploy/docker-compose.node.yml"\n```\n', opts)).rejects.toThrow(/docker-compose\.node\.yml" not found/);
  });
  it("refuses an allowed name that is a symbolic link out of deploy/", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcsm-repo-"));
    try {
      fs.mkdirSync(path.join(root, "deploy"));
      fs.writeFileSync(path.join(root, "secret.txt"), "TOKEN=hunter2\n");
      fs.symlinkSync(path.join(root, "secret.txt"), path.join(root, "deploy/docker-compose.yml"));
      await expect(compileDoc('```yaml include="deploy/docker-compose.yml"\n```\n', { ...opts, repoRoot: root })).rejects.toThrow(/resolves outside deploy\//);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
