import { useEffect } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, apiPath, type JobDetailDto, type JobDto } from "@/lib/api";
import { realtime } from "@/lib/ws";
import { jobKey, jobsKey, normalizeStatus, retainJobsLive, type JobsFilter } from "@/lib/jobs";

export function useJobs(filter: JobsFilter = {}) {
  const params = new URLSearchParams({ limit: "100" });
  if (filter.serverId) params.set("serverId", filter.serverId);
  const status = normalizeStatus(filter.status);
  if (status) params.set("status", status);
  return useQuery({ queryKey: jobsKey(filter), queryFn: () => api.get<JobDto[]>(`/api/jobs?${params}`), placeholderData: keepPreviousData });
}

export function useJob(id: string) {
  return useQuery({ queryKey: jobKey(id), queryFn: () => api.get<JobDetailDto>(apiPath`/api/jobs/${id}`) });
}

/** Mantiene jobs y copias al día con el topic `jobs` mientras el componente esté montado. */
export function useJobsLive() {
  const qc = useQueryClient();
  useEffect(() => retainJobsLive(qc, realtime), [qc]);
}
