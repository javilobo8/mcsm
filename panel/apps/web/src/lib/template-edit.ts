import type { SpecPatch } from "@mcsm/shared";
import { FORM_KEYS, buildSpecPatch, type EditableSpec } from "./spec-edit";

/** Secciones que edita una plantilla: todas las del formulario salvo `ports` y `router` (del servidor concreto). */
export const TEMPLATE_KEYS = FORM_KEYS.filter((k) => k !== "ports" && k !== "router");

/** Por qué no se puede guardar la plantilla (nombre vacío o errores de campo vigentes); null si se puede. */
export function templateSaveBlock(name: string, errors: Readonly<Record<string, string>>): string | null {
  if (!name.trim()) return "El nombre es obligatorio";
  const n = Object.keys(errors).length;
  if (n > 0) return `Corrige ${n} ${n === 1 ? "campo con error" : "campos con error"} antes de guardar`;
  return null;
}

/** Cuerpo del POST: una plantilla nunca lleva `ports` ni `router`. */
export function templateCreateBody(name: string, description: string, spec: EditableSpec) {
  const { ports: _ports, router: _router, ...rest } = spec;
  return { name: name.trim(), description: description.trim(), spec: rest };
}

/** Cuerpo del PATCH: solo las secciones cambiadas (`null` borra las opcionales), sin `ports`. */
export function templatePatchBody(original: EditableSpec, edited: EditableSpec, name: string, description: string): { name: string; description: string; spec: SpecPatch } {
  return { name: name.trim(), description: description.trim(), spec: buildSpecPatch(original, edited, TEMPLATE_KEYS) };
}

/** PATCH que quita la programación de copias de una plantilla (los servidores nuevos dejan de heredarla). */
export const REMOVE_SCHEDULE_PATCH = { spec: { backups: null } } as const;
