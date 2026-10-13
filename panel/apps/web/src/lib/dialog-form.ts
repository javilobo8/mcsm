/**
 * `onSubmit` of a `<form>` inside a Dialog. The dialog is rendered in a portal, but React's synthetic
 * events bubble up the component tree: without `stopPropagation`, the submit also reaches the
 * `<form>` that contains the dialog (e.g. the CurseForge API key inside the configuration or the
 * template editor would save and navigate). Use it in EVERY dialog form, even if today it does not hang
 * from another form (dialog-form.test.ts checks it).
 */
export function dialogSubmit(action: () => void) {
  return (e: { preventDefault(): void; stopPropagation(): void }) => {
    e.preventDefault();
    e.stopPropagation();
    action();
  };
}
