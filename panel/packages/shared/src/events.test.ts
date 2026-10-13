import { describe, expect, it } from "vitest";
import { eventKindLabel, eventsQuerySchema, EVENT_KIND_RE } from "./events.js";

describe("events", () => {
  it("query: default values, coercion and limits", () => {
    expect(eventsQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(eventsQuerySchema.parse({ limit: "10", minLevel: "warn" })).toEqual({ limit: 10, minLevel: "warn" });
    expect(eventsQuerySchema.parse({ before: "2026-10-13T04:00:00.000Z" }).before).toBe("2026-10-13T04:00:00.000Z");
    expect(eventsQuerySchema.parse({ before: "2026-10-13T04:00:00.000Z", beforeId: "abc" }).beforeId).toBe("abc");
    for (const bad of [{ beforeId: "" }, { limit: "0" }, { limit: "201" }, { minLevel: "debug" }, { before: "ayer" }, { serverId: "" }]) {
      expect(eventsQuerySchema.safeParse(bad).success).toBe(false);
    }
  });

  it("valid labels and kinds", () => {
    expect(eventKindLabel("crash_loop")).toBe("Crash loop");
    expect(eventKindLabel("unknown")).toBe("Other");
    expect(EVENT_KIND_RE.test("save_on_pending")).toBe(true);
    expect(EVENT_KIND_RE.test("Raro!")).toBe(false);
  });
});
