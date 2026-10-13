import { describe, expect, it } from "vitest";
import { eventKindLabel, eventsQuerySchema, EVENT_KIND_RE } from "./events.js";

describe("eventos", () => {
  it("query: valores por defecto, coerción y límites", () => {
    expect(eventsQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(eventsQuerySchema.parse({ limit: "10", minLevel: "warn" })).toEqual({ limit: 10, minLevel: "warn" });
    expect(eventsQuerySchema.parse({ before: "2026-10-13T04:00:00.000Z" }).before).toBe("2026-10-13T04:00:00.000Z");
    for (const bad of [{ limit: "0" }, { limit: "201" }, { minLevel: "debug" }, { before: "ayer" }, { serverId: "" }]) {
      expect(eventsQuerySchema.safeParse(bad).success).toBe(false);
    }
  });

  it("etiquetas y tipos válidos", () => {
    expect(eventKindLabel("crash_loop")).toBe("Bucle de crash");
    expect(eventKindLabel("desconocido")).toBe("Otro");
    expect(EVENT_KIND_RE.test("save_on_pending")).toBe(true);
    expect(EVENT_KIND_RE.test("Raro!")).toBe(false);
  });
});
