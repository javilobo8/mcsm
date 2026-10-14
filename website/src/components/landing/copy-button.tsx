import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

export function CopyButton({ text, className, label = "Copy" }: { text: string; className?: string; label?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const onClick = async () => {
    const ok = await copyText(text);
    setState(ok ? "copied" : "failed");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), 1600);
  };

  return (
    <button
      type="button"
      onClick={() => void onClick()}
      className={cn(
        "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-fog transition-colors hover:bg-accent hover:text-bone",
        state === "copied" && "text-grass-bright hover:text-grass-bright",
        className,
      )}
    >
      {state === "copied" ? <Check className="size-3.5" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
      <span aria-live="polite">{state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : label}</span>
    </button>
  );
}

/**
 * A shell snippet with a copy button. `display` is what is shown (it may wrap long commands with "\");
 * `copy` is what goes to the clipboard (defaults to the displayed text).
 */
export function Snippet({ display, copy, title, className, compact = false }: { display: string; copy?: string; title?: string; className?: string; compact?: boolean }) {
  return (
    <div className={cn("overflow-hidden rounded-lg border border-cobble bg-[#0b0d10]", className)}>
      <div className="flex min-h-10 items-center justify-between gap-3 border-b border-cobble pr-1.5 pl-4">
        <span className="truncate text-xs text-fog">{title ?? "Terminal"}</span>
        <CopyButton text={copy ?? display} />
      </div>
      <pre className={cn("overflow-x-auto px-4 py-3.5 font-mono leading-[1.7] text-[#e6edf3]", compact ? "text-xs" : "text-[0.8125rem]")} tabIndex={0}>
        <code>
          {display.split("\n").map((line, i) => (
            <span key={i} className="block">
              {line.startsWith("#") ? <span className="text-fog">{line}</span> : line}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}
