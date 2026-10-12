/**
 * `onSubmit` de un `<form>` dentro de un Dialog. El diálogo se pinta en un portal, pero los eventos
 * sintéticos de React suben por el árbol de componentes: sin `stopPropagation`, el submit llega también
 * al `<form>` que contiene al diálogo (p. ej. la API key de CurseForge dentro de la configuración o del
 * editor de plantillas guardaría y navegaría). Úsalo en TODO formulario de diálogo, aunque hoy no cuelgue
 * de otro formulario (lo comprueba dialog-form.test.ts).
 */
export function dialogSubmit(action: () => void) {
  return (e: { preventDefault(): void; stopPropagation(): void }) => {
    e.preventDefault();
    e.stopPropagation();
    action();
  };
}
