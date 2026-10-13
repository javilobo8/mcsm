import type { SpecPatch } from "@mcsm/shared";
import { FORM_KEYS, buildSpecPatch, type EditableSpec } from "./spec-edit";

/** Sections a template edits: all those of the form except `ports` and `router` (specific to the actual server). */
export const TEMPLATE_KEYS = FORM_KEYS.filter((k) => k !== "ports" && k !== "router");

/** Why the template cannot be saved (empty name or current field errors); null if it can. */
export function templateSaveBlock(name: string, errors: Readonly<Record<string, string>>): string | null {
  if (!name.trim()) return "The name is required";
  const n = Object.keys(errors).length;
  if (n > 0) return `Fix ${n} ${n === 1 ? "field with an error" : "fields with errors"} before saving`;
  return null;
}

/** POST body: a template never carries `ports` or `router`. */
export function templateCreateBody(name: string, description: string, spec: EditableSpec) {
  const { ports: _ports, router: _router, ...rest } = spec;
  return { name: name.trim(), description: description.trim(), spec: rest };
}

/** PATCH body: only the changed sections (`null` removes optional ones), without `ports`. */
export function templatePatchBody(original: EditableSpec, edited: EditableSpec, name: string, description: string): { name: string; description: string; spec: SpecPatch } {
  return { name: name.trim(), description: description.trim(), spec: buildSpecPatch(original, edited, TEMPLATE_KEYS) };
}

/** PATCH that removes a template's backup schedule (new servers stop inheriting it). */
export const REMOVE_SCHEDULE_PATCH = { spec: { backups: null } } as const;
