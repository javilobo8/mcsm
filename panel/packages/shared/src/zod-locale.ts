import { z } from "zod";

// Default zod messages in English for the panel and the web (they share this zod instance).
z.config(z.locales.en());
