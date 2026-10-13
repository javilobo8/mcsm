import { describe, expect, it } from "vitest";
import { create, fromBinary, toBinary, type MessageInitShape } from "@bufbuild/protobuf";
import { EnvelopeSchema, EventLevel } from "@mcsm/proto";
import { isResponseCase } from "./hub.js";

const roundTrip = (init: MessageInitShape<typeof EnvelopeSchema>) =>
  fromBinary(EnvelopeSchema, toBinary(EnvelopeSchema, create(EnvelopeSchema, init)));

describe("Plan 9 protocol", () => {
  it("no new body resolves a request: RotateToken replies with Ack", () => {
    for (const c of ["event", "streamDropped", "rotateToken"]) expect(isResponseCase(c)).toBe(false);
  });

  it("Event travels with level, server, kind, message and time", () => {
    const env = roundTrip({ body: { case: "event", value: { level: EventLevel.ERROR, serverId: "s1", kind: "crash_loop", message: "parado", tsUnixMs: 5n } } });
    if (env.body.case !== "event") throw new Error(`body ${env.body.case}`);
    expect(env.body.value).toMatchObject({ level: EventLevel.ERROR, serverId: "s1", kind: "crash_loop", message: "parado", tsUnixMs: 5n });
  });

  it("StreamDropped goes in the stream's stream_id and RotateToken carries the token", () => {
    const sd = roundTrip({ streamId: 9n, body: { case: "streamDropped", value: { count: 3n } } });
    expect(sd.streamId).toBe(9n);
    expect(sd.body.case === "streamDropped" && sd.body.value.count).toBe(3n);
    const rt = roundTrip({ id: 4n, body: { case: "rotateToken", value: { token: "x".repeat(43) } } });
    expect(rt.body.case === "rotateToken" && rt.body.value.token).toBe("x".repeat(43));
  });
});
