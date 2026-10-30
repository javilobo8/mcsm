import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { ContentImage } from "./content-image";
import { Description } from "./description";

describe("ContentImage", () => {
  it("only loads the panel's image proxy", () => {
    expect(renderToString(<ContentImage src="/api/content/image?url=https%3A%2F%2Fcdn.modrinth.com%2Fa.png" alt="Sodium" />)).toContain('<img src="/api/content/image?url=');
    for (const src of ["https://cdn.modrinth.com/a.png", "//evil/x.png", "javascript:alert(1)", null]) {
      const html = renderToString(<ContentImage src={src} alt="Sodium" />);
      expect(html).not.toContain("<img");
      expect(html).toContain('aria-label="Sodium"');
    }
  });
  it("a decorative placeholder is hidden from screen readers", () => {
    expect(renderToString(<ContentImage src={null} alt="" />)).toContain('aria-hidden="true"');
  });
});

describe("Description", () => {
  it("renders the API's sanitised HTML and says when there is none", () => {
    expect(renderToString(<Description html="<p>Fast <strong>rendering</strong></p>" />)).toContain("<p>Fast <strong>rendering</strong></p>");
    expect(renderToString(<Description html="  " />)).toContain("This project has no description.");
  });
});
