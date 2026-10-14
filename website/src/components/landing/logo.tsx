import { cn } from "@/lib/utils";

/** The mark: an isometric grass block, drawn on a 32-unit grid like the favicon. */
export function BlockMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={cn("size-7 shrink-0", className)} shapeRendering="crispEdges">
      <path fill="#72c04e" d="M16 2 29 9 16 16 3 9Z" />
      <path fill="#5aa23a" d="M3 9 16 16v14L3 23Z" />
      <path fill="#46852c" d="M29 9 16 16v14l13-7Z" />
      <path fill="#8a5a37" d="M3 13.5 16 20.5V30L3 23Z" />
      <path fill="#6d4529" d="M29 13.5 16 20.5V30l13-7Z" />
      <path fill="#8fd668" d="M16 2 22.5 5.5 16 9 9.5 5.5Z" opacity=".55" />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <BlockMark />
      <span className="font-pixel text-[1.0625rem] font-semibold tracking-tight whitespace-nowrap text-bone">MC Server Manager</span>
    </span>
  );
}

/** GitHub's mark (lucide no longer ships brand icons). */
export function GitHubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={cn("size-5", className)} fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}
