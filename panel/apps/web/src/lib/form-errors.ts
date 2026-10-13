/** Map of the form's field errors (field id -> message). Pure functions, no React. */
export type FormErrors = Readonly<Record<string, string>>;

/** Ids that are not a DOM element (computed errors): never purged for being "not mounted". */
export const VIRTUAL_ERROR_IDS: ReadonlySet<string> = new Set(["sf-memlimit-rel", "sf-extra-ports", "sf-ops-env", "sf-whitelist-env"]);

/** Sets or removes (message null) a field's error; returns the same object if nothing changes. */
export function applyError(prev: FormErrors, field: string, message: string | null): FormErrors {
  if (message === null) {
    if (!(field in prev)) return prev;
    const { [field]: _gone, ...rest } = prev;
    return rest;
  }
  return prev[field] === message ? prev : { ...prev, [field]: message };
}

/** Removes the errors of fields that are no longer mounted (e.g. a fieldset hidden when the type changes). */
export function pruneErrors(prev: FormErrors, isMounted: (field: string) => boolean): FormErrors {
  let next = prev;
  for (const f of Object.keys(prev)) if (!VIRTUAL_ERROR_IDS.has(f) && !f.startsWith("sf-extra-") && !isMounted(f)) next = applyError(next, f, null);
  return next;
}
