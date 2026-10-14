import { StatusBadge } from "@/components/status";
import { displayState } from "@/lib/format";
import type { ObservedDto } from "@/lib/api";

export function StateBadge({ observed, desired, nodeOnline }: { observed: ObservedDto | null; desired: string; nodeOnline?: boolean }) {
  const { text, tone } = displayState(observed, desired, nodeOnline);
  return <StatusBadge tone={tone} title={observed?.error || undefined}>{text}</StatusBadge>;
}
