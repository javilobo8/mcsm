// Runs inside the Playwright container (see screenshots.sh): a static server for dist/ plus Chromium.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium } from "playwright-core";

const root = path.resolve("dist");
const out = path.resolve("screenshots");
const base = process.env.SITE_BASE || "/mcsm/";
const types = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".png": "image/png", ".webp": "image/webp", ".woff2": "font/woff2", ".xml": "application/xml", ".txt": "text/plain",
};

// Like GitHub Pages: files and directories with index.html, otherwise 404.html with status 404.
const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url ?? "/").split("?")[0]);
  let file = url.startsWith(base) ? path.join(root, url.slice(base.length)) : "";
  if (file && !file.startsWith(root)) file = "";
  if (file && fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  const found = file && fs.existsSync(file) && fs.statSync(file).isFile();
  const target = found ? file : path.join(root, "404.html");
  res.writeHead(found ? 200 : 404, { "content-type": types[path.extname(target)] ?? "application/octet-stream" });
  fs.createReadStream(target).pipe(res);
});
await new Promise((r) => server.listen(4173, "127.0.0.1", r));
const site = `http://127.0.0.1:4173${base}`;

const docsDir = path.join(root, "docs");
const slugs = fs.existsSync(docsDir) ? fs.readdirSync(docsDir).filter((d) => fs.existsSync(path.join(docsDir, d, "index.html"))) : [];
const docSlug = slugs.includes("installation") ? "installation" : slugs.sort()[0];
const deepLink = process.env.DEEP_LINK || (slugs.includes("backups") ? "docs/backups/#restoring-and-pre-restore-data" : "");

const browser = await chromium.launch();
const problems = [];

async function settle(page) {
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1800); // let the one-off entrance animation finish
}

/** Scrolls through the page like a reader would, so scroll-triggered reveals run, then back to the top. */
async function scrollThrough(page) {
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < height; y += 500) {
    await page.evaluate((top) => window.scrollTo(0, top), y);
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
}

async function shoot(name, url, viewport, { fullPage = true, before } = {}) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on("pageerror", (e) => problems.push(`${name}: page error: ${e.message}`));
  page.on("console", (m) => {
    // The docs 404 page is served with status 404 on purpose.
    if (m.type() === "error" && !(name.includes("404") && m.text().includes("404"))) problems.push(`${name}: console: ${m.text()}`);
  });
  page.on("response", (r) => r.status() >= 400 && !r.url().includes("/docs/nope") && problems.push(`${name}: ${r.status()} ${r.url()}`));
  await page.goto(url);
  await settle(page);
  if (fullPage) await scrollThrough(page);
  if (before) await before(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 0) problems.push(`${name}: horizontal overflow of ${overflow}px`);
  await page.screenshot({ path: path.join(out, `${name}.png`), fullPage });
  console.log(`wrote screenshots/${name}.png`);
  await context.close();
}

const desktop = { width: 1440, height: 900 };
const tablet = { width: 820, height: 1180 };
const mobile = { width: 390, height: 844 };

await shoot("landing-1440", site, desktop);
await shoot("landing-390", site, mobile);
if (docSlug) {
  await shoot("docs-1440", `${site}docs/${docSlug}/`, desktop);
  await shoot("docs-820", `${site}docs/${docSlug}/`, tablet);
  // Between md and lg the docs sidebar is hidden: the menu must still reach the docs navigation.
  await shoot("docs-menu-820", `${site}docs/${docSlug}/`, tablet, {
    fullPage: false,
    before: async (page) => {
      await page.getByRole("button", { name: "Open the menu" }).click();
      await page.getByRole("dialog").getByRole("navigation", { name: "Documentation" }).waitFor();
      await page.waitForTimeout(500);
    },
  });
  await shoot("docs-390", `${site}docs/${docSlug}/`, mobile);
  await shoot("search-1440", `${site}docs/${docSlug}/`, desktop, {
    fullPage: false,
    before: async (page) => {
      await page.keyboard.press("Control+k");
      await page.getByPlaceholder("Search the docs").fill("backup");
      await page.getByRole("dialog").waitFor();
      await page.waitForTimeout(600);
    },
  });
  await shoot("search-390", `${site}docs/${docSlug}/`, mobile, {
    fullPage: false,
    before: async (page) => {
      await page.getByRole("button", { name: "Search docs" }).click();
      await page.getByRole("dialog").waitFor();
      await page.waitForTimeout(600);
    },
  });
  await shoot("docs-menu-390", `${site}docs/${docSlug}/`, mobile, {
    fullPage: false,
    before: async (page) => {
      await page.getByRole("button", { name: "Open the menu" }).click();
      await page.waitForTimeout(500);
    },
  });
  await shoot("docs-404-1440", `${site}docs/nope/`, desktop, { fullPage: false });
}
if (deepLink) {
  // A deep link opened directly must land on its heading, below the sticky header.
  const id = decodeURIComponent(deepLink.split("#")[1] ?? "");
  await shoot("deep-link-1440", `${site}${deepLink}`, desktop, {
    fullPage: false,
    before: async (page) => {
      const top = await page.evaluate((i) => document.getElementById(i)?.getBoundingClientRect().top ?? null, id);
      const scrollY = await page.evaluate(() => window.scrollY);
      console.log(`deep link ${deepLink}: scrollY=${scrollY}, heading top=${top}`);
      if (top === null || top < 56 || top > 160) problems.push(`deep link ${deepLink}: heading at ${top}px from the top`);
    },
  });
}

await browser.close();
server.close();
if (problems.length) {
  console.log(`\nproblems:\n- ${problems.join("\n- ")}`);
  process.exitCode = 1;
}
