import { useState } from "react";
import { Button } from "@/components/ui/button";
import { EventList } from "@/components/event-list";
import { EVENT_FILTERS } from "@/lib/events";

/** Incidents of the nodes and servers: crashes, crash loops, OOM, recreated containers… (spec §5.3, §10). */
export function EventsPage() {
  const [selected, setSelected] = useState(EVENT_FILTERS[0]!);
  return (
    <div className="flex flex-col gap-4 p-6">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Events</h1>
        <div className="flex gap-1" role="group" aria-label="Filter by level">
          {EVENT_FILTERS.map((f) => (
            <Button key={f.label} size="sm" variant={selected === f ? "secondary" : "ghost"} aria-pressed={selected === f} onClick={() => setSelected(f)}>{f.label}</Button>
          ))}
        </div>
      </header>
      <EventList filter={{ minLevel: selected.minLevel }} />
    </div>
  );
}
