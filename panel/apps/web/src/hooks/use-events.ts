import { useQuery } from "@tanstack/react-query";
import type { EventDto } from "@mcsm/shared";
import { api } from "@/lib/api";
import { eventsKey, eventsUrl, type EventsFilter } from "@/lib/events";

/** Eventos más recientes; el WS (bindEvents, en useLive) los recarga al llegar uno nuevo. */
export function useEvents(filter: EventsFilter) {
  return useQuery({ queryKey: eventsKey(filter), queryFn: () => api.get<EventDto[]>(eventsUrl(filter)) });
}
