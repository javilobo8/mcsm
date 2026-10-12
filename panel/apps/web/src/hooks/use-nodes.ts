import { useQuery } from "@tanstack/react-query";
import { api, type NodeDto } from "@/lib/api";

export function useNodes() {
  return useQuery({ queryKey: ["nodes"], queryFn: () => api.get<NodeDto[]>("/api/nodes"), refetchInterval: 30_000 });
}
