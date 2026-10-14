import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/** Status tones of the palette: ok (grass), warn (torch), bad (redstone), info (diamond) and muted. */
export type Tone = "ok" | "warn" | "bad" | "info" | "muted";

export const TONE_TEXT: Record<Tone, string> = {
  ok: "text-ok", warn: "text-warn", bad: "text-bad", info: "text-info", muted: "text-muted-foreground",
};

export const TONE_FILL: Record<Tone, string> = {
  ok: "bg-grass", warn: "bg-torch", bad: "bg-redstone", info: "bg-diamond", muted: "bg-cobble-2",
};

const TONE_CHIP: Record<Tone, string> = {
  ok: "border-grass/35 bg-grass/10 text-ok",
  warn: "border-torch/35 bg-torch/10 text-warn",
  bad: "border-redstone/40 bg-redstone/10 text-bad",
  info: "border-diamond/35 bg-diamond/10 text-info",
  muted: "border-cobble-2 bg-bedrock-2 text-muted-foreground",
};

/** A status chip with a square LED in the tone's colour. */
export function StatusBadge({ tone, title, className, children }: { tone: Tone; title?: string; className?: string; children: ReactNode }) {
  return (
    <Badge variant="outline" className={cn(TONE_CHIP[tone], className)} title={title}>
      <span className={cn("led", tone === "muted" && "shadow-none")} aria-hidden="true" />
      {children}
    </Badge>
  );
}
