import { useQuery } from "@tanstack/react-query";
import type { EventDto } from "@mcsm/shared";
import { api } from "@/lib/api";
import { eventsKey, eventsUrl, type EventsFilter } from "@/lib/events";

/** Most recent events; the WS (bindEvents, in useLive) reloads them when a new one arrives. */
export function useEvents(filter: EventsFilter) {
  return useQuery({ queryKey: eventsKey(filter), queryFn: () => api.get<EventDto[]>(eventsUrl(filter)) });
}
