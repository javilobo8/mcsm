import { useState } from "react";
import { Button } from "@/components/ui/button";
import { EventList } from "@/components/event-list";
import { EVENT_FILTERS } from "@/lib/events";

/** Incidencias de los nodos y servidores: crashes, bucles de crash, OOM, contenedores recreados… (spec §5.3, §10). */
export function EventsPage() {
  const [selected, setSelected] = useState(EVENT_FILTERS[0]!);
  return (
    <div className="flex flex-col gap-4 p-6">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Eventos</h1>
        <div className="flex gap-1" role="group" aria-label="Filtrar por nivel">
          {EVENT_FILTERS.map((f) => (
            <Button key={f.label} size="sm" variant={selected === f ? "secondary" : "ghost"} aria-pressed={selected === f} onClick={() => setSelected(f)}>{f.label}</Button>
          ))}
        </div>
      </header>
      <EventList filter={{ minLevel: selected.minLevel }} />
    </div>
  );
}
