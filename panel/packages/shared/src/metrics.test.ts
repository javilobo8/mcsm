import { describe, expect, it } from "vitest";
import { METRIC_RANGES, metricBuckets, metricRangeSchema } from "./metrics.js";

describe("metricBuckets", () => {
  it("1h: 360 buckets of 10 s, the last one contains now", () => {
    const b = metricBuckets("1h", 1_760_000_017);
    expect(b).toEqual({ from: 1_760_000_010 - 359 * 10, step: 10, count: 360 });
  });
  it("24h: 1440 buckets of 1 min; 7d: 2016 buckets of 5 min", () => {
    expect(metricBuckets("24h", 1_760_000_017)).toMatchObject({ step: 60, count: 1440 });
    expect(metricBuckets("7d", 1_760_000_017)).toMatchObject({ step: 300, count: 2016 });
    expect(metricBuckets("7d", 1_760_000_017).from % 300).toBe(0);
  });
  it("each range covers exactly its duration", () => {
    for (const r of Object.keys(METRIC_RANGES) as (keyof typeof METRIC_RANGES)[]) {
      const { step, count } = metricBuckets(r, 1_760_000_000);
      expect(step * count).toBe(METRIC_RANGES[r].seconds);
    }
  });
});

describe("metricRangeSchema", () => {
  it("accepts 1h/24h/7d and rejects the rest", () => {
    expect(metricRangeSchema.parse("24h")).toBe("24h");
    const r = metricRangeSchema.safeParse("30d");
    expect(r.success).toBe(false);
  });
});
