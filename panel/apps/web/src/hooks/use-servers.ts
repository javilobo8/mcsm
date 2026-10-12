import { useQuery } from "@tanstack/react-query";
import { api, type ServerDto } from "@/lib/api";

export function useServers() {
  return useQuery({ queryKey: ["servers"], queryFn: () => api.get<ServerDto[]>("/api/servers"), refetchInterval: 30_000 });
}

export function useServer(id: string) {
  return useQuery({ queryKey: ["server", id], queryFn: () => api.get<ServerDto>(`/api/servers/${id}`) });
}
