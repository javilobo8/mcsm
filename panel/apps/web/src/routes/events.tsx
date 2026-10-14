import { useState } from "react";
import { Button } from "@/components/ui/button";
import { EventList } from "@/components/event-list";
import { PAGE, PageHeader } from "@/components/page-header";
import { EVENT_FILTERS } from "@/lib/events";

/** Incidents of the nodes and servers: crashes, crash loops, OOM, recreated containers… (spec §5.3, §10). */
export function EventsPage() {
  const [selected, setSelected] = useState(EVENT_FILTERS[0]!);
  return (
    <div className={PAGE}>
      <PageHeader
        title="Events"
        description="Crashes, crash loops, out-of-memory kills and other incidents on your nodes and servers."
        actions={
          <div className="flex gap-1" role="group" aria-label="Filter by level">
            {EVENT_FILTERS.map((f) => (
              <Button key={f.label} size="sm" variant={selected === f ? "secondary" : "ghost"} aria-pressed={selected === f} onClick={() => setSelected(f)}>{f.label}</Button>
            ))}
          </div>
        }
      />
      <EventList filter={{ minLevel: selected.minLevel }} />
    </div>
  );
}
