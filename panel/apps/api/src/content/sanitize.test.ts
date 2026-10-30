import { describe, expect, it } from "vitest";
import { descriptionHtml } from "./sanitize.js";

describe("descriptionHtml", () => {
  it("drops scripts, event handlers and javascript: links", () => {
    const out = descriptionHtml({ html: `<p onclick="x()">hi<script>alert(1)</script><a href="javascript:alert(1)">x</a></p>` });
    expect(out).not.toMatch(/script|onclick|javascript:/i);
  });

  it("opens links in a new tab without opener", () => {
    expect(descriptionHtml({ markdown: "[docs](https://example.com)" })).toContain(`<a href="https://example.com" target="_blank" rel="noopener noreferrer">docs</a>`);
  });

  it("does not keep a target or rel the source set", () => {
    const out = descriptionHtml({ html: `<a href="https://example.com" target="_self" rel="opener">x</a>` });
    expect(out).toBe(`<a href="https://example.com" target="_blank" rel="noopener noreferrer">x</a>`);
  });

  it("proxies CDN images and turns foreign images into links", () => {
    const out = descriptionHtml({ markdown: "![a](https://cdn.modrinth.com/data/x/a.png) ![b](https://i.imgur.com/b.png)" });
    expect(out).toContain(`src="/api/content/image?url=${encodeURIComponent("https://cdn.modrinth.com/data/x/a.png")}"`);
    expect(out).toContain(`<a href="https://i.imgur.com/b.png" target="_blank" rel="noopener noreferrer">b</a>`);
  });

  it("turns an image without alt or with a non-https source into a plain link or nothing", () => {
    expect(descriptionHtml({ html: `<img src="https://i.imgur.com/c.png">` })).toBe(`<a href="https://i.imgur.com/c.png" target="_blank" rel="noopener noreferrer">image</a>`);
    expect(descriptionHtml({ html: `<img src="http://cdn.modrinth.com/a.png" alt="x">` })).not.toContain("<img");
    expect(descriptionHtml({ html: `<img src="data:image/svg+xml;base64,AAAA" alt="x">` })).not.toMatch(/<img|data:/);
  });

  it("removes iframes, svg and inline styles", () => {
    expect(descriptionHtml({ html: `<iframe src="https://youtube.com"></iframe><svg onload="x"></svg><p style="color:red">t</p>` })).toBe("<p>t</p>");
  });

  it("sanitises raw HTML inside Markdown the same way", () => {
    const out = descriptionHtml({ markdown: `# Title\n\n<div onmouseover="x()"><center>ok</center><form><input></form></div>` });
    expect(out).toContain("<h1>Title</h1>");
    expect(out).toContain("<center>ok</center>");
    expect(out).not.toMatch(/onmouseover|<form|<input/);
  });

  it("caps the input at 512 KiB", () => expect(descriptionHtml({ markdown: "a".repeat(600 * 1024) }).length).toBeLessThanOrEqual(512 * 1024 + 16));
});
