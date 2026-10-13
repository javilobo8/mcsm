import { Link } from "@tanstack/react-router";
import { EVENT_LEVEL_LABEL, eventKindLabel } from "@mcsm/shared";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useEvents } from "@/hooks/use-events";
import { useNodes } from "@/hooks/use-nodes";
import { EVENTS_LIMIT, eventSubject, levelTone, type EventsFilter } from "@/lib/events";

/** Tabla de eventos (incidencias de los agentes y del panel), en vivo por el topic `events`. */
export function EventList({ filter, showSubject = true }: { filter: EventsFilter; showSubject?: boolean }) {
  const events = useEvents(filter);
  const nodes = useNodes();
  const nodeName = (id: string | null) => (id ? nodes.data?.find((n) => n.id === id)?.name : undefined);
  const cols = showSubject ? 5 : 4;
  return (
    <>
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-44">Fecha</TableHead>
          <TableHead>Nivel</TableHead>
          <TableHead>Tipo</TableHead>
          {showSubject && <TableHead>Servidor o nodo</TableHead>}
          <TableHead>Mensaje</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {events.isPending && <TableRow><TableCell colSpan={cols} className="text-center text-zinc-400">Cargando eventos…</TableCell></TableRow>}
        {events.isError && <TableRow><TableCell colSpan={cols} className="text-center text-red-400">No se pudieron cargar los eventos: {events.error.message}</TableCell></TableRow>}
        {events.data?.length === 0 && <TableRow><TableCell colSpan={cols} className="text-center text-zinc-400">Sin eventos.</TableCell></TableRow>}
        {events.data?.map((e) => (
          <TableRow key={e.id} data-testid={`event-${e.kind}`}>
            <TableCell className="text-xs text-zinc-400">{new Date(e.createdAt).toLocaleString()}</TableCell>
            <TableCell><Badge variant="outline" className={levelTone(e.level)}>{EVENT_LEVEL_LABEL[e.level]}</Badge></TableCell>
            <TableCell className="text-sm">{eventKindLabel(e.kind)}</TableCell>
            {showSubject && (
              <TableCell className="text-sm">
                {e.serverId && e.serverName
                  ? <Link to="/servers/$serverId" params={{ serverId: e.serverId }} className="hover:underline">{eventSubject(e)}</Link>
                  : eventSubject(e, nodeName(e.nodeId))}
              </TableCell>
            )}
            <TableCell className="max-w-xl whitespace-pre-wrap text-sm">{e.message}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
    <p className="mt-2 text-xs text-zinc-500">Se muestran los {EVENTS_LIMIT} eventos más recientes.</p>
    </>
  );
}
