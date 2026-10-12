import { Badge } from "@/components/ui/badge";
import { displayState } from "@/lib/format";
import type { ObservedDto } from "@/lib/api";

const tones = {
  ok: "bg-emerald-600/20 text-emerald-300 border-emerald-700",
  warn: "bg-amber-600/20 text-amber-300 border-amber-700",
  bad: "bg-red-600/20 text-red-300 border-red-700",
  muted: "bg-zinc-800 text-zinc-400 border-zinc-700",
};

export function StateBadge({ observed, desired, nodeOnline }: { observed: ObservedDto | null; desired: string; nodeOnline?: boolean }) {
  const { text, tone } = displayState(observed, desired, nodeOnline);
  return <Badge variant="outline" className={tones[tone]} title={observed?.error || undefined}>{text}</Badge>;
}
