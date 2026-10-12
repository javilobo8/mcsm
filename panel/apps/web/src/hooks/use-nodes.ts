import { useQuery } from "@tanstack/react-query";
import { api, type NodeDto } from "@/lib/api";
import { useLive } from "./use-live";

export function useNodes() {
  useLive();
  return useQuery({ queryKey: ["nodes"], queryFn: () => api.get<NodeDto[]>("/api/nodes"), refetchInterval: 30_000 });
}
