import { z } from "zod";

// zod 4 compiles validators with `new Function` and, to know whether it can, probes it when building each
// z.object. With the panel's CSP (script-src 'self') the probe fails and zod uses the slow path, but the
// browser reports it as a CSP violation. Without JIT it does not probe. It has to go before building
// any schema: main.tsx imports it first.
z.config({ jitless: true });
