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

/** Detail of a job (with its log). Without an id it queries nothing. */
export function useJob(id: string | null) {
  return useQuery({ queryKey: jobKey(id ?? ""), queryFn: () => api.get<JobDetailDto>(apiPath`/api/jobs/${id ?? ""}`), enabled: id !== null });
}

/** Keeps jobs and backups up to date with the `jobs` topic while the component is mounted. */
export function useJobsLive() {
  const qc = useQueryClient();
  useEffect(() => retainJobsLive(qc, realtime), [qc]);
}
