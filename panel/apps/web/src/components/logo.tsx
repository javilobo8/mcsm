import { cn } from "@/lib/utils";

/** The mark: an isometric grass block, drawn on a 32-unit grid like the favicon (the same as the website's). */
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
      <span className="font-pixel text-[1.0625rem] leading-tight font-semibold tracking-tight text-bone">MC Server Manager</span>
    </span>
  );
}
