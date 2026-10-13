import { describe, expect, it } from "vitest";
import { create, fromBinary, toBinary, type MessageInitShape } from "@bufbuild/protobuf";
import { EnvelopeSchema, EventLevel } from "@mcsm/proto";
import { isResponseCase } from "./hub.js";

const roundTrip = (init: MessageInitShape<typeof EnvelopeSchema>) =>
  fromBinary(EnvelopeSchema, toBinary(EnvelopeSchema, create(EnvelopeSchema, init)));

describe("protocolo del Plan 9", () => {
  it("ningún cuerpo nuevo resuelve una petición: RotateToken responde con Ack", () => {
    for (const c of ["event", "streamDropped", "rotateToken"]) expect(isResponseCase(c)).toBe(false);
  });

  it("Event viaja con nivel, servidor, tipo, mensaje y hora", () => {
    const env = roundTrip({ body: { case: "event", value: { level: EventLevel.ERROR, serverId: "s1", kind: "crash_loop", message: "parado", tsUnixMs: 5n } } });
    if (env.body.case !== "event") throw new Error(`cuerpo ${env.body.case}`);
    expect(env.body.value).toMatchObject({ level: EventLevel.ERROR, serverId: "s1", kind: "crash_loop", message: "parado", tsUnixMs: 5n });
  });

  it("StreamDropped va en el stream_id del stream y RotateToken lleva el token", () => {
    const sd = roundTrip({ streamId: 9n, body: { case: "streamDropped", value: { count: 3n } } });
    expect(sd.streamId).toBe(9n);
    expect(sd.body.case === "streamDropped" && sd.body.value.count).toBe(3n);
    const rt = roundTrip({ id: 4n, body: { case: "rotateToken", value: { token: "x".repeat(43) } } });
    expect(rt.body.case === "rotateToken" && rt.body.value.token).toBe("x".repeat(43));
  });
});
