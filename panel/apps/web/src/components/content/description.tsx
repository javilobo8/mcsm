/**
 * A project's description. `html` is ALWAYS the API's `descriptionHtml`: the panel renders Modrinth Markdown and
 * CurseForge HTML and sanitises it server side (sanitize-html allowlist, http/https links with
 * rel="noopener noreferrer", images only through the panel's proxy). This component never receives upstream HTML.
 */
export function Description({ html }: { html: string }) {
  if (!html.trim()) return <p className="text-sm text-muted-foreground">This project has no description.</p>;
  return <div className="content-description" dangerouslySetInnerHTML={{ __html: html }} />;
}
