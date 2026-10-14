export function SkipLink() {
  return (
    <a
      href="#main"
      className="sr-only z-50 rounded-md bg-grass px-3 py-2 text-sm font-semibold text-primary-foreground focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
    >
      Skip to content
    </a>
  );
}
