import { describe, expect, it } from "vitest";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { EnvelopeSchema, MetricBatchSchema } from "@mcsm/proto";

const roundtrip = (tps?: number) => {
  const env = create(EnvelopeSchema, {
    body: { case: "metricBatch", value: create(MetricBatchSchema, { tsUnix: 1_760_000_000n, servers: [{ serverId: "a", cpuPct: 12.5, mcOnline: true, playersOnline: 3, ...(tps === undefined ? {} : { tps }) }] }) },
  });
  const back = fromBinary(EnvelopeSchema, toBinary(EnvelopeSchema, env));
  if (back.body.case !== "metricBatch") throw new Error("se esperaba metricBatch");
  return back.body.value;
};

describe("MetricBatch (protocolo)", () => {
  it("viaja en el Envelope sin host y con un servidor", () => {
    const b = roundtrip();
    expect(b.tsUnix).toBe(1_760_000_000n);
    expect(b.host).toBeUndefined();
    expect(b.servers[0]).toMatchObject({ serverId: "a", cpuPct: 12.5, mcOnline: true, playersOnline: 3 });
  });
  it("distingue TPS ausente de TPS 0 (campo optional)", () => {
    expect(roundtrip().servers[0]!.tps).toBeUndefined();
    expect(roundtrip(0).servers[0]!.tps).toBe(0);
    expect(roundtrip(19.5).servers[0]!.tps).toBe(19.5);
  });
});
