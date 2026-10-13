import { useQuery } from "@tanstack/react-query";
import type { SettingsDto } from "@mcsm/shared";
import { api } from "@/lib/api";

export const settingsKey = ["settings"] as const;
export function useSettings() {
  return useQuery({ queryKey: settingsKey, queryFn: () => api.get<SettingsDto>("/api/settings") });
}
