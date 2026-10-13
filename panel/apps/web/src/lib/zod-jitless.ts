import { z } from "zod";

// zod 4 compila validadores con `new Function` y, para saber si puede, lo prueba al construir cada
// z.object. Con la CSP del panel (script-src 'self') la prueba falla y zod usa la ruta lenta, pero el
// navegador lo notifica como violación de la CSP. Sin JIT no lo prueba. Tiene que ir antes de construir
// cualquier esquema: main.tsx lo importa el primero.
z.config({ jitless: true });
