import { useQuery } from "@tanstack/react-query";
import { api, apiPath, type TemplateDto } from "@/lib/api";

export function useTemplates() {
  return useQuery({ queryKey: ["templates"], queryFn: () => api.get<TemplateDto[]>("/api/templates") });
}

export function useTemplate(id: string) {
  return useQuery({ queryKey: ["template", id], queryFn: () => api.get<TemplateDto>(apiPath`/api/templates/${id}`) });
}
