import { z } from "zod";

// Mensajes por defecto de zod en castellano para el panel y la web (comparten esta instancia de zod).
z.config(z.locales.es());
